import {
  ipcMainHandle,
  ipcMainOn,
  ipcMainSendMainWindow,
} from "@/common/ipc-util/main";
import {
  closeLyricWindow,
  createLyricWindow,
  getLyricWindow,
  getMainWindow,
} from "../window";
import {
  BrowserWindow,
  MessageChannelMain,
  app,
  dialog,
  ipcRenderer,
  net,
  shell,
} from "electron";
import { currentMusicInfoStore } from "../store/current-music";
import { PlayerState } from "@/renderer/core/track-player/enum";
import { setupTrayMenu } from "../tray";
import axios from "axios";
import { compare } from "compare-versions";
import { getPluginByMedia } from "../core/plugin-manager";
import { encodeUrlHeaders } from "@/common/normalize-util";
import { getQualityOrder } from "@/common/media-util";
import { getAppConfigPath, setAppConfigPath } from "@/common/app-config/main";
import { getExtensionWindow, syncExtensionData } from "../core/extensions";

let messageChannel: MessageChannelMain;

export default function setupIpcMain() {
  ipcMainOn("min-window", ({ skipTaskBar }) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (skipTaskBar) {
        mainWindow.hide();
        mainWindow.setSkipTaskbar(true);
      }
      mainWindow.minimize();
    }
  });

  ipcMainOn("open-url", (url) => {
    shell.openExternal(url);
  });

  ipcMainOn('open-path', (path) => {
    shell.openPath(path);
  })

  ipcMainHandle("show-open-dialog", (options) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      throw new Error("Invalid Window");
    }
    return dialog.showOpenDialog(options);
  });

  ipcMainHandle("show-save-dialog", (options) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      throw new Error("Invalid Window");
    }
    return dialog.showSaveDialog(options);
  });

  ipcMainOn("exit-app", () => {
    app.exit(0);
  });

  ipcMainOn("sync-current-music", (musicItem) => {
    currentMusicInfoStore.setValue((prev) => ({
      ...prev,
      currentMusic: musicItem ?? null,
    }));
    syncExtensionData({
      currentMusic: musicItem,
    });
    setupTrayMenu();
  });

  ipcMainOn("sync-current-playing-state", (playerState) => {
    currentMusicInfoStore.setValue((prev) => ({
      ...prev,
      currentPlayerState: playerState ?? PlayerState.None,
    }));
    syncExtensionData({
      playerState: playerState ?? PlayerState.None,
    });
    setupTrayMenu();
  });

  ipcMainOn("sync-current-repeat-mode", (repeatMode) => {
    currentMusicInfoStore.setValue((prev) => ({
      ...prev,
      currentRepeatMode: repeatMode,
    }));
    setupTrayMenu();
  });

  ipcMainHandle('app-get-path', pathName => {
    return app.getPath(pathName as any);
  })

  /** APP更新 */
  const updateSources = [
    "https://gitee.com/maotoumao/MusicFreeDesktop/raw/master/release/version.json",
    "https://raw.githubusercontent.com/maotoumao/MusicFreeDesktop/master/release/version.json",
  ];
  ipcMainHandle("check-update", async () => {
    const currentVersion = app.getVersion();
    const updateInfo: ICommon.IUpdateInfo = {
      version: currentVersion,
    };
    for (let i = 0; i < updateSources.length; ++i) {
      try {
        const rawInfo = (await axios.get(updateSources[i])).data;
        if (compare(rawInfo.version, currentVersion, ">")) {
          updateInfo.update = rawInfo;
          return updateInfo;
        }
      } catch {
        continue;
      }
    }
    return updateInfo;
  });


  ipcMainHandle("set-lyric-window", (enabled) => {
    setLyricWindow(enabled);
  });

  ipcMainOn("send-to-lyric-window", (data) => {
    const lyricWindow = getLyricWindow();
    if (!lyricWindow) {
      return;
    }
    currentMusicInfoStore.setValue((prev) => ({
      ...prev,
      lrc: data.lrc,
    }));
    syncExtensionData({
      lrc: data.lrc,
    });
  });

  ipcMainOn("set-desktop-lyric-lock", (lockState) => {
    setDesktopLyricLock(lockState);
  });

  ipcMainOn("ignore-mouse-event", async (data) => {
    const targetWindow =
      data.window === "main" ? getMainWindow() : getLyricWindow();
    if (!targetWindow) {
      return;
    }
    targetWindow.setIgnoreMouseEvents(data.ignore, {
      forward: true,
    });
  });

  ipcMainOn("player-cmd", (data) => {
    ipcMainSendMainWindow("player-cmd", data);
  });

  ipcMainOn("extension-inited", (_, evt) => {
    const targetWindow = getExtensionWindow(evt.sender.id);

    if (targetWindow) {
      const currentMusicInfo = currentMusicInfoStore.getValue();

      syncExtensionData(
        {
          currentMusic: currentMusicInfo.currentMusic,
          playerState: currentMusicInfo.currentPlayerState,
          lrc: currentMusicInfo.lrc,
        },
        targetWindow
      );
    }
  });
}

export async function setLyricWindow(enabled: boolean) {
  if (enabled) {
    let lyricWindow = getLyricWindow();
    if (!lyricWindow) {
      lyricWindow = createLyricWindow();
    }
  } else {
    closeLyricWindow();
  }
  await setAppConfigPath("lyric.enableDesktopLyric", enabled);
  setupTrayMenu();
}

export async function setDesktopLyricLock(lockState: boolean) {
  const result = await setAppConfigPath("lyric.lockLyric", lockState);

  if (result) {
    const lyricWindow = getLyricWindow();

    if (!lyricWindow) {
      return;
    }
    if (lockState) {
      lyricWindow.setIgnoreMouseEvents(true, {
        forward: true,
      });
    } else {
      lyricWindow.setIgnoreMouseEvents(false);
    }
  }
  setupTrayMenu();

}
