import Store from "@/common/store";
import trackPlayer from "./internal";
import { PlayerState, RepeatMode, TrackPlayerEvent } from "./enum";
import trackPlayerEventsEmitter from "./event";
import shuffle from "lodash.shuffle";
import {
  addSortProperty,
  getInternalData,
  getQualityOrder,
  isSameMedia,
  sortByTimestampAndIndex,
} from "@/common/media-util";
import { timeStampSymbol, sortIndexSymbol } from "@/common/constant";
import { callPluginDelegateMethod } from "../plugin-delegate";
import LyricParser from "@/renderer/utils/lyric-parser";
import {
  getUserPerference,
  getUserPerferenceIDB,
  removeUserPerference,
  setUserPerference,
  setUserPerferenceIDB,
} from "@/renderer/utils/user-perference";
import rendererAppConfig from "@/common/app-config/renderer";
import { delay } from "@/common/time-util";
import { ipcRendererOn, ipcRendererSend } from "@/common/ipc-util/renderer";
import Evt from "../events";

const initProgress = {
  currentTime: 0,
  duration: Infinity,
};

/** 音乐队列 */
const musicQueueStore = new Store<IMusic.IMusicItem[]>([]);

/** 当前播放 */
const currentMusicStore = new Store<IMusic.IMusicItem | null>(null);

interface ICurrentLyric {
  parser?: LyricParser;
  currentLrc?: {
    lrc?: ILyric.IParsedLrcItem; // 当前时刻的歌词
    index?: number; // 下标
  };
}
/** 当前歌词解析器 */
const currentLyricStore = new Store<ICurrentLyric | null>(null);

/** 播放模式 */
const repeatModeStore = new Store(RepeatMode.Queue);

/** 进度 */
const progressStore = new Store(initProgress);

/** 播放状态 */
const playerStateStore = new Store(PlayerState.None);

/** 音量 */
const currentVolumeStore = new Store(1);

/** 速度 */
const currentSpeedStore = new Store(1);

/** 音质 */
const currentQualityStore = new Store<IMusic.IQualityKey>("standard");

/** 播放下标 */
let currentIndex = -1;

/** 初始化 */
export async function setupPlayer() {
  setupEvents();
  const _repeatMode = getUserPerference("repeatMode");

  const [currentMusic, currentProgress] = [
    getUserPerference("currentMusic"),
    getUserPerference("currentProgress"),
  ];
  const playList = (await getUserPerferenceIDB("playList")) ?? [];
  musicQueueStore.setValue(playList);

  if (_repeatMode) {
    setRepeatMode(_repeatMode as RepeatMode);
  }

  setCurrentMusic(currentMusic);
  setAudioOutputDevice(
    rendererAppConfig.getAppConfigPath("playMusic.audioOutputDevice.deviceId")
  );

  const [volume, speed] = [
    getUserPerference("volume"),
    getUserPerference("speed"),
  ];
  if (volume) {
    currentVolumeStore.setValue(volume);
    setVolume(volume);
  }

  if (speed) {
    currentSpeedStore.setValue(speed);
    setSpeed(speed);
  }

  trackPlayerEventsEmitter.emit(TrackPlayerEvent.UpdateLyric);
  try {
    const { mediaSource, quality } = await getMediaSource(currentMusic, {
      quality:
        getUserPerference("currentQuality") ||
        rendererAppConfig.getAppConfigPath("playMusic.defaultQuality"),
    });

    setTrackAndPlay(mediaSource, currentMusic, {
      seekTo: currentProgress,
      autoPlay: false,
    });

    setCurrentQuality(quality);
  } catch {}
  currentIndex = findMusicIndex(currentMusic);
}

function setupEvents() {
  trackPlayerEventsEmitter.on(TrackPlayerEvent.PlayEnd, () => {
    progressStore.setValue(initProgress);
    removeUserPerference("currentProgress");
    switch (repeatModeStore.getValue()) {
      case RepeatMode.Queue:
      case RepeatMode.Shuffle: {
        skipToNext();
        break;
      }
      case RepeatMode.Loop: {
        playIndex(currentIndex);
        break;
      }
    }
  });

  trackPlayerEventsEmitter.on(TrackPlayerEvent.TimeUpdated, (res) => {
    progressStore.setValue(res);
    setUserPerference("currentProgress", res.currentTime);
    const currentLyric = currentLyricStore.getValue();
    if (currentLyric?.parser) {
      const lrcItem = currentLyric.parser.getPosition(res.currentTime);
      if (lrcItem?.lrc !== currentLyric.currentLrc?.lrc) {
        currentLyricStore.setValue({
          parser: currentLyric.parser,
          currentLrc: lrcItem,
        });
      }
    }
  });

  trackPlayerEventsEmitter.on(TrackPlayerEvent.VolumeChanged, (res) => {
    setUserPerference("volume", res);
    currentVolumeStore.setValue(res);
  });

  trackPlayerEventsEmitter.on(TrackPlayerEvent.SpeedChanged, (res) => {
    setUserPerference("speed", res);
    currentSpeedStore.setValue(res);
  });

  trackPlayerEventsEmitter.on(TrackPlayerEvent.StateChanged, (st) => {
    playerStateStore.setValue(st);
    ipcRendererSend("sync-current-playing-state", st);
  });

  trackPlayerEventsEmitter.on(TrackPlayerEvent.Error, async () => {
    progressStore.setValue(initProgress);
    removeUserPerference("currentProgress");
    const currentMusic = currentMusicStore.getValue();
    // 播放错误时自动跳到下一首, 间隔500ms，防止疯狂循环。。
    if (
      musicQueueStore.getValue().length > 1 &&
      rendererAppConfig.getAppConfigPath("playMusic.playError") === "skip"
    ) {
      await delay(500);
      if (isSameMedia(currentMusic, currentMusicStore.getValue())) {
        skipToNext();
      }
    }
  });

  // 更新当前音乐的歌词
  trackPlayerEventsEmitter.on(TrackPlayerEvent.UpdateLyric, async () => {
    const currentMusic = currentMusicStore.getValue();
    // 当前没有歌曲
    if (!currentMusic) {
      currentLyricStore.setValue(null);
      return;
    }

    const currentLyric = currentLyricStore.getValue();
    // 已经有了
    if (
      currentLyric &&
      isSameMedia(currentLyric?.parser?.getCurrentMusicItem?.(), currentMusic)
    ) {
      return;
    } else {
      try {
        const lyric = await callPluginDelegateMethod(
          currentMusic,
          "getLyric",
          currentMusic
        );
        if (!isSameMedia(currentMusic, currentMusicStore.getValue())) {
          return;
        }
        if (!lyric?.rawLrc) {
          currentLyricStore.setValue({});
          return;
        }
        const rawLrc = lyric?.rawLrc;
        const parser = new LyricParser(rawLrc, currentMusic);
        currentLyricStore.setValue({
          parser,
        });
      } catch (e) {
        console.log(e, "歌词解析失败");
        currentLyricStore.setValue({});
        // 解析歌词失败
      }
    }
  });

  navigator.mediaSession.setActionHandler("nexttrack", () => {
    skipToNext();
  });

  ipcRendererOn("player-cmd", (data) => {
    const { cmd, payload } = data;
    if (cmd === "skip-next") {
      skipToNext();
    } else if (cmd === "skip-prev") {
      skipToPrev();
    } else if (cmd === "set-repeat-mode") {
      setRepeatMode(payload as RepeatMode);
    } else if (cmd === "set-player-state") {
      if (payload === PlayerState.Playing) {
        resumePlay();
      } else {
        pause();
      }
    }
  });

  navigator.mediaSession.setActionHandler("previoustrack", () => {
    skipToPrev();
  });

  /** 行为 */
  Evt.on("SKIP_NEXT", () => {
    skipToNext();
  });
  Evt.on("SKIP_PREVIOUS", () => {
    skipToPrev();
  });
  Evt.on("TOGGLE_PLAYER_STATE", () => {
    console.log("on");
    const currentState = getPlayerState();
    if (currentState === PlayerState.Playing) {
      pause();
    } else {
      resumePlay();
    }
  });
  Evt.on("VOLUME_UP", (val = 0.04) => {
    setVolume(Math.min(1, currentVolumeStore.getValue() + val));
  });
  Evt.on("VOLUME_DOWN", (val = 0.04) => {
    setVolume(Math.max(0, currentVolumeStore.getValue() - val));
  });
}

function setMusicQueue(musicQueue: IMusic.IMusicItem[]) {
  musicQueueStore.setValue(musicQueue);
  setUserPerferenceIDB("playList", musicQueue);
}

/** 设置当前播放的音乐 */
function setCurrentMusic(music: IMusic.IMusicItem | null) {
  if (!isSameMedia(music, currentMusicStore.getValue())) {
    currentMusicStore.setValue(music);
    currentLyricStore.setValue(null);
    trackPlayerEventsEmitter.emit(TrackPlayerEvent.UpdateLyric);
    if(music) {
      setUserPerference("currentMusic", music);
    } else {
      removeUserPerference('currentMusic');
    }
    ipcRendererSend(
      "sync-current-music",
      music
        ? {
            platform: music.platform,
            title: music.title,
            artist: music.artist,
            id: music.id,
            album: music.album,
          }
        : null
    );
  } else {
    currentMusicStore.setValue(music);
  }
}

function setCurrentQuality(quality: IMusic.IQualityKey) {
  setUserPerference("currentQuality", quality);
  currentQualityStore.setValue(quality);
}


export const getCurrentMusic = currentMusicStore.getValue;

export const useCurrentMusic = currentMusicStore.useValue;

export const useProgress = progressStore.useValue;

export const getProgress = progressStore.getValue;

export const getPlayerState = playerStateStore.getValue;

export const usePlayerState = playerStateStore.useValue;

export const useRepeatMode = repeatModeStore.useValue;

export const getMusicQueue = musicQueueStore.getValue;

export const useMusicQueue = musicQueueStore.useValue;

export const useLyric = currentLyricStore.useValue;

export const useVolume = currentVolumeStore.useValue;

export const useSpeed = currentSpeedStore.useValue;

export const useQuality = currentQualityStore.useValue;

export function toggleRepeatMode() {
  let nextRepeatMode: RepeatMode = repeatModeStore.getValue();
  switch (nextRepeatMode) {
    case RepeatMode.Shuffle:
      nextRepeatMode = RepeatMode.Loop;
      break;
    case RepeatMode.Loop:
      nextRepeatMode = RepeatMode.Queue;
      break;
    case RepeatMode.Queue:
      nextRepeatMode = RepeatMode.Shuffle;
      break;
  }
  setRepeatMode(nextRepeatMode);
}

export function setRepeatMode(repeatMode: RepeatMode) {
  if (repeatMode === RepeatMode.Shuffle) {
    setMusicQueue(shuffle(musicQueueStore.getValue()));
  } else if (repeatModeStore.getValue() === RepeatMode.Shuffle) {
    setMusicQueue(sortByTimestampAndIndex(musicQueueStore.getValue(), true));
  }
  repeatModeStore.setValue(repeatMode);
  setUserPerference("repeatMode", repeatMode);
  currentIndex = findMusicIndex(currentMusicStore.getValue());
  ipcRendererSend("sync-current-repeat-mode", repeatMode);
}

function findMusicIndex(musicItem?: IMusic.IMusicItem) {
  if (!musicItem) {
    return -1;
  }
  const musicQueue = musicQueueStore.getValue();
  return musicQueue.findIndex((item) => isSameMedia(musicItem, item));
}

/**
 * 歌单行为
 */

export function addNext(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) {
  let _musicItems: IMusic.IMusicItem[];
  if (Array.isArray(musicItems)) {
    _musicItems = musicItems;
  } else {
    _musicItems = [musicItems];
  }

  const now = Date.now();

  const currentMusic = currentMusicStore.getValue();
  let duplicateIndex = -1;
  _musicItems.forEach((item, index) => {
    _musicItems[index] = {
      ...item,
      [timeStampSymbol]: now,
      [sortIndexSymbol]: index,
    };
    if (duplicateIndex === -1 && isSameMedia(item, currentMusic)) {
      duplicateIndex = index;
    }
  });

  if (duplicateIndex !== -1) {
    _musicItems = [
      _musicItems[duplicateIndex],
      ..._musicItems.slice(0, duplicateIndex),
      ..._musicItems.slice(duplicateIndex + 1),
    ];
  }

  const queue = musicQueueStore.getValue();

  if (!currentMusic) {
    // 加在末尾
    const filteredQueue = queue.filter(
      (item) => _musicItems.findIndex((mi) => isSameMedia(item, mi)) === -1
    );
    setMusicQueue([...filteredQueue, ..._musicItems]);
  } else {
    const prevQueue = queue
      .slice(0, currentIndex + 1)
      .filter(
        (item) => _musicItems.findIndex((mi) => isSameMedia(item, mi)) === -1
      );
    const tailQueue = queue
      .slice(currentIndex + 1)
      .filter(
        (item) => _musicItems.findIndex((mi) => isSameMedia(item, mi)) === -1
      );

    const newQueue = [...prevQueue, ..._musicItems, ...tailQueue];
    setMusicQueue(newQueue);
    currentIndex = findMusicIndex(currentMusic);
  }
}

export function skipToPrev() {
  const musicQueue = musicQueueStore.getValue();
  if (musicQueue.length === 0) {
    currentIndex = -1;
    setCurrentMusic(null);
    return;
  }
  playIndex(currentIndex - 1);
}

export function skipToNext() {
  const musicQueue = musicQueueStore.getValue();
  if (musicQueue.length === 0) {
    currentIndex = -1;
    setCurrentMusic(null);
    return;
  }
  playIndex(currentIndex + 1);
}

function splice() {}

interface IGetMediaSourceOptions {
  /** quality */
  quality?: IMusic.IQualityKey;
}

async function getMediaSource(
  musicItem: IMusic.IMusicItem,
  options?: IGetMediaSourceOptions
) {
  const qualityOrder = getQualityOrder(
    options.quality ??
      rendererAppConfig.getAppConfigPath("playMusic.defaultQuality"),
    rendererAppConfig.getAppConfigPath("playMusic.whenQualityMissing")
  );
  let mediaSource: IPlugin.IMediaSourceResult | null = null;
  let realQuality: IMusic.IQualityKey = qualityOrder[0];
  // 1. 已下载
  const downloadedData = getInternalData<IMusic.IMusicItemInternalData>(
    musicItem,
    "downloadData"
  );
  if (downloadedData) {
    const { quality, path: _path } = downloadedData;
    if (await window.fs.isFile(_path)) {
      return {
        quality,
        mediaSource: {
          url: _path,
        },
      };
    } else {
      // TODO 删除
    }
  }
  for (const quality of qualityOrder) {
    try {
      mediaSource = await callPluginDelegateMethod(
        {
          platform: musicItem.platform,
        },
        "getMediaSource",
        musicItem,
        quality
      );
      if (!mediaSource?.url) {
        continue;
      }
      realQuality = quality;
      break;
    } catch {}
  }

  return {
    quality: realQuality,
    mediaSource,
  };
}

interface IPlayOptions {
  /** 播放相同音乐时是否从头开始 */
  restartOnSameMedia?: boolean;
  /** 强制更新源 */
  refreshSource?: boolean;
  /** seetTo */
  seekTo?: number;
  /** quality */
  quality?: IMusic.IQualityKey;
}

async function playIndex(nextIndex: number, options: IPlayOptions = {}) {
  const musicQueue = musicQueueStore.getValue();

  nextIndex = (nextIndex + musicQueue.length) % musicQueue.length;
  // 歌曲重复
  if (
    !options?.refreshSource &&
    currentIndex === nextIndex &&
    isSameMedia(currentMusicStore.getValue(), musicQueue[nextIndex]) &&
    currentIndex !== -1
  ) {
    const restartOnSameMedia = options?.restartOnSameMedia ?? true;
    if (restartOnSameMedia) {
      trackPlayer.seekTo(0);
    }
    trackPlayer.play();
  } else {
    currentIndex = nextIndex;

    // 插件获取media
    const musicItem = musicQueue[currentIndex];

    try {
      const { mediaSource, quality } = await getMediaSource(musicItem, {
        quality: options.quality,
      });
      if (!mediaSource?.url) {
        throw new Error("Empty Source");
      }
      console.log("MEDIA SOURCE", mediaSource, musicItem);
      if (isSameMedia(musicItem, musicQueueStore.getValue()[currentIndex])) {
        setCurrentQuality(quality);
        setCurrentMusic(musicItem);
        setTrackAndPlay(mediaSource, musicItem);
      }
    } catch (e) {
      // 播放失败
      setCurrentMusic(musicItem);
      setCurrentQuality(
        rendererAppConfig.getAppConfigPath("playMusic.defaultQuality")
      );
      trackPlayer.clear();
      trackPlayerEventsEmitter.emit(TrackPlayerEvent.Error, e);
    }
  }
}

export async function playMusic(
  musicItem: IMusic.IMusicItem,
  options?: IPlayOptions
) {
  const musicQueue = musicQueueStore.getValue();
  const queueIndex = findMusicIndex(musicItem);
  if (queueIndex === -1) {
    // 添加到列表末尾
    const newQueue = [
      ...musicQueue,
      {
        ...musicItem,
        [timeStampSymbol]: Date.now(),
        [sortIndexSymbol]: 0,
      },
    ];
    setMusicQueue(newQueue);
    await playIndex(newQueue.length - 1, options);
  } else {
    await playIndex(queueIndex, options);
  }
}

/** 播放并替换列表 */
export async function playMusicWithReplaceQueue(
  musicList: IMusic.IMusicItem[],
  musicItem?: IMusic.IMusicItem
) {
  if (!musicList.length && !musicItem) {
    return;
  }
  addSortProperty(musicList);
  if (repeatModeStore.getValue() === RepeatMode.Shuffle) {
    musicList = shuffle(musicList);
  }
  musicItem = musicItem ?? musicList[0];
  setMusicQueue(musicList);
  await playMusic(musicItem);
}

export function resumePlay() {
  trackPlayer.play();
}

interface ISetTrackOptions {
  // 默认自动播放
  autoPlay?: boolean;
  seekTo?: number;
}

/** 内部播放 */
function setTrackAndPlay(
  mediaSource: IPlugin.IMediaSourceResult,
  musicItem: IMusic.IMusicItem,
  options: ISetTrackOptions = {
    autoPlay: true,
  }
) {
  progressStore.setValue(initProgress);
  removeUserPerference("currentProgress");
  trackPlayer.setTrackSource(mediaSource, musicItem);
  if (options.seekTo) {
    trackPlayer.seekTo(options.seekTo);
  }
  if (options.autoPlay) {
    trackPlayer.play();
  }
}
/** 清空播放队列 */
export function clearQueue() {
  trackPlayer.clear();
  setMusicQueue([]);
  setCurrentMusic(null);
  progressStore.setValue({
    currentTime: 0,
    duration: Infinity,
  });
  currentIndex = -1;
}

export function removeFromQueue(musicItem: IMusic.IMusicItem | number) {
  let musicIndex: number;
  if (typeof musicItem !== "number") {
    musicIndex = findMusicIndex(musicItem);
  } else {
    musicIndex = musicItem;
  }
  if (musicIndex === -1) {
    return;
  }

  if (musicIndex === currentIndex) {
    trackPlayer.clear();
    currentIndex = -1;
    setCurrentMusic(null);
  }

  const newQueue = [...musicQueueStore.getValue()];
  newQueue.splice(musicIndex, 1);

  setMusicQueue(newQueue);
  currentIndex = findMusicIndex(currentMusicStore.getValue());
}

export function seekTo(position: number) {
  trackPlayer.seekTo(position);
}

export function pause() {
  trackPlayer.pause();
}

export function setVolume(volume: number) {
  trackPlayer.setVolume(volume);
}

export function setSpeed(speed: number) {
  trackPlayer.setSpeed(speed);
}

export async function setQuality(quality: IMusic.IQualityKey) {
  const currentMusic = currentMusicStore.getValue();
  if (currentMusic && quality !== currentQualityStore.getValue()) {
    const { mediaSource, quality: realQuality } = await getMediaSource(
      currentMusic,
      {
        quality,
      }
    );
    if (isSameMedia(currentMusic, currentMusicStore.getValue())) {
      setTrackAndPlay(mediaSource, currentMusic, {
        seekTo: progressStore.getValue().currentTime,
        autoPlay:
          playerStateStore.getValue() === PlayerState.Playing ? true : false,
      });
      setCurrentQuality(realQuality);
    }
  }
}

export async function setAudioOutputDevice(deviceId?: string) {
  try {
    await trackPlayer.setSinkId(deviceId ?? "");
    return true;
  } catch {
    return false;
  }
}
