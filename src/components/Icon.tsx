import type { ReactNode } from "react";

export type IconName =
  | "back"
  | "check"
  | "close"
  | "export"
  | "film"
  | "fit"
  | "folder"
  | "forward"
  | "info"
  | "minus"
  | "music"
  | "mute"
  | "pause"
  | "play"
  | "plus"
  | "redo"
  | "scissors"
  | "trash"
  | "unlink"
  | "undo"
  | "volume";

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

const paths: Record<IconName, ReactNode> = {
  back: (
    <>
      <path d="M7 5v14" />
      <path d="m17 6-8 6 8 6Z" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 14v5h14v-5" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4" />
    </>
  ),
  fit: (
    <>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      <path d="m3 8 5-5M21 8l-5-5M3 16l5 5M21 16l-5 5" />
    </>
  ),
  folder: (
    <path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
  forward: (
    <>
      <path d="M17 5v14" />
      <path d="m7 6 8 6-8 6Z" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  music: (
    <>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </>
  ),
  mute: (
    <>
      <path d="M5 10v4h4l5 4V6l-5 4Z" />
      <path d="m17 9 4 6M21 9l-4 6" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7Z" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  redo: (
    <>
      <path d="m15 6 4 4-4 4" />
      <path d="M19 10h-8a6 6 0 0 0-6 6v1" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="7" r="3" />
      <circle cx="6" cy="17" r="3" />
      <path d="m8.5 8.5 10 8.5M8.5 15.5 18.5 7" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 3h6l1 4H8Z" />
      <path d="m6 7 1 14h10l1-14M10 11v6M14 11v6" />
    </>
  ),
  unlink: (
    <>
      <path d="m9 15-2 2a4 4 0 0 1-6-6l3-3a4 4 0 0 1 5-1" />
      <path d="m15 9 2-2a4 4 0 0 1 6 6l-3 3a4 4 0 0 1-5 1" />
      <path d="m8 12 8 0M12 4v3M12 17v3" />
    </>
  ),
  undo: (
    <>
      <path d="m9 6-4 4 4 4" />
      <path d="M5 10h8a6 6 0 0 1 6 6v1" />
    </>
  ),
  volume: (
    <>
      <path d="M5 10v4h4l5 4V6l-5 4Z" />
      <path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
    </>
  ),
};

export function Icon({ name, size = 18, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      {paths[name]}
    </svg>
  );
}
