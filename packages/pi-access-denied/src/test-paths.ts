import { createPathAPI } from "./paths.ts";

/** @internal Fixed POSIX environment shared by behavior tests. */
export const posixPaths = createPathAPI({
  platform: "posix",
  cwd: "/workspace/project",
  home: "/home/test-user",
  username: "test-user",
  temp: "/temporary",
  realTmp: "/private/tmp",
});

/** @internal Fixed Windows environment shared by behavior tests on every host. */
export const windowsPaths = createPathAPI({
  platform: "win32",
  cwd: "C:/workspace/project",
  home: "C:/Users/test-user",
  username: "test-user",
  temp: "C:/Temp",
});
