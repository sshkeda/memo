const CONTROL_SEQUENCE = String.raw`\u001B\[[0-?]*[ -/]*[@-~]?`;
export const TERMINAL_FORMATTING = new RegExp(CONTROL_SEQUENCE, "gu");
const LINE_BREAK = /[\v\f\u0085]/gu;
const C0_CONTROL = /[^\P{Cc}\t\n\r\v\f\u007F-\u009F]/gu;
const DELETE = "\u007F";
const CONTROL_PICTURES = 0x24_00;
const DELETE_PICTURE = "\u2421";
const CONTROL_CHARACTER = /[^\P{Cc}\t\n\r]/gu;

export const sanitize = (text: string) =>
  text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(TERMINAL_FORMATTING, "")
    .replace(LINE_BREAK, "\n")
    .replace(C0_CONTROL, (control) =>
      String.fromCodePoint(CONTROL_PICTURES + (control.codePointAt(0) ?? 0)),
    )
    .replaceAll(DELETE, DELETE_PICTURE)
    .replace(CONTROL_CHARACTER, "\uFFFD");
