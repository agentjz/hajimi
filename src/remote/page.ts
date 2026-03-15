import { loadRemoteAsset } from "./assets.js";

export function renderRemoteControlPage(): Promise<string> {
  return loadRemoteAsset("index.html");
}

export function renderRemoteControlStyles(): Promise<string> {
  return loadRemoteAsset("remote.css");
}

export function renderRemoteControlScript(): Promise<string> {
  return loadRemoteAsset("remote.js");
}

export function renderRemoteControlAsset(name: string): Promise<string> {
  return loadRemoteAsset(name);
}
