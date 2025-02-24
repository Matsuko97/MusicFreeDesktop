declare namespace IpcEvents {
  // 由 Renderer 发出的ipc通信

  interface Renderer {
    /** 最小化窗口 */
    "min-window": {
      skipTaskBar?: boolean; // 是否隐藏任务栏
    };

    /** 退出应用 */
    "exit-app": undefined;

    /** 刷新插件 */
    "refresh-plugins": undefined;

    "open-url": string;
    'open-path': string;

    "sync-current-music": IMusic.IMusicItem;
    "sync-current-playing-state": import("@/renderer/core/track-player/enum").PlayerState;
    "sync-current-repeat-mode": import("@/renderer/core/track-player/enum").RepeatMode;


    /** 本地文件 */
    "sync-local-music": undefined;
    "add-watch-dir": string[];
    "remove-watch-dir": string[];
    "set-watch-dir": {
      add?: string[],
      rm?: string[]
    };
    'send-to-lyric-window': {
      // 时序
      timeStamp: number;
      lrc: ILyric.IParsedLrcItem[]
    };
    'set-desktop-lyric-lock': boolean;
    'ignore-mouse-event': {
      ignore: boolean,
      window: 'main' | 'lyric'
    };
    'player-cmd': {
      cmd: IPlayerCmd,
      payload?: any
    },
    /** 扩展窗口已经初始化完成 */
    'extension-inited': undefined;
    /** 设置歌词窗口位置 */
    'set-lyric-window-pos': ICommon.IPoint;

    /** 快捷键 */
    'enable-global-short-cut': boolean;
    'bind-global-short-cut': {
      key: keyof import('../../app-config/type').IAppConfig["shortCut"]["shortcuts"],
      shortCut: string[]
    }
    'unbind-global-short-cut': {
      key: keyof import('../../app-config/type').IAppConfig["shortCut"]["shortcuts"],
      shortCut: string[]
    }
  }
}

/** 需要回执 */
declare namespace IpcInvoke {
  type IAppConfig = import("@/common/app-config/type").IAppConfig;
  type IAppConfigKeyPath = import("@/common/app-config/type").IAppConfigKeyPath;
  type IAppConfigKeyPathValue =
    import("@/common/app-config/type").IAppConfigKeyPathValue;

  interface Renderer {
    "get-all-plugins": () => IPlugin.IPluginDelegate[];
    "call-plugin-method": <
      T extends keyof IPlugin.IPluginInstanceMethods
    >(arg: {
      // 通过hash或者platform查找插件
      hash?: string;
      platform?: string;
      // 方法
      method: T;
      // 参数
      args: Parameters<IPlugin.IPluginInstanceMethods[T]>;
    }) => ReturnType<IPlugin.IPluginInstanceMethods[T]>;
    /** 同步设置 */
    "sync-app-config": () => IAppConfig;
    "set-app-config": (appConfig: IAppConfig) => boolean;
    "set-app-config-path": <Key extends IAppConfigKeyPath>(arg: {
      keyPath: Key;
      value: IAppConfigKeyPathValue<Key>;
    }) => boolean;
    "install-plugin-remote": (url: string) => void;
    "install-plugin-local": (url: string) => void;
    "uninstall-plugin": (pluginhash: string) => void;
    "show-open-dialog": (
      options: Electron.OpenDialogOptions
    ) => Electron.OpenDialogReturnValue;
    "show-save-dialog": (
      options: Electron.SaveDialogOptions
    ) => Electron.SaveDialogReturnValue;

    "check-update": () => ICommon.IUpdateInfo;
    "set-lyric-window": (show: boolean) => void; 
    /** 主窗口和歌词窗口之间 */
    'app-get-path': (pathName: string) => string;
  }
}
