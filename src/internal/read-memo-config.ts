import { Config, ConfigProvider, Context, Effect, Layer, Option, Result, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { File } from "effect/FileSystem";
import { Path } from "effect/Path";
import { Stdio } from "effect/Stdio";

import { decodeUtf8Strictly } from "./decode-utf8-strictly.ts";
import {
  ConfigFileError,
  ConfigFileTypeError,
  ConfigurationError,
  DataDirectoryTypeError,
  DataDirectoryUnsetError,
} from "./memo-errors.ts";

export const outputColor = Effect.gen(function* () {
  const stdio = yield* Stdio;
  const noColor = yield* Config.String("NO_COLOR").pipe(Config.withDefault(""));
  const term = yield* Config.String("TERM").pipe(Config.withDefault(""));
  return (yield* stdio.stdoutIsTerminal) && noColor === "" && term !== "dumb";
}).pipe(Effect.mapError((error) => new ConfigurationError({ message: String(error) })));
export const withEmptyEnvironmentValues = Effect.provideServiceEffect(
  ConfigProvider.ConfigProvider,
  Effect.sync(() => ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
);
const nonEmpty = (value: string) => value !== "";
const filledIn = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.filter(nonEmpty)));
export const debugEnabled = filledIn("MEMO_DEBUG").pipe(Config.map(Option.isSome));
export const userHome = Config.all([filledIn("HOME"), filledIn("USERPROFILE")]).pipe(
  Config.map(([home, profile]) => Option.getOrUndefined(Option.orElse(home, () => profile))),
  Effect.mapError((error) => new ConfigurationError({ message: String(error) })),
);
export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly directory: string;
  }
>()("memo/AppConfig") {}

const MEMO_HOME_VARIABLE = "MEMO_HOME";
export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

const windows = (platform: string): boolean => platform === "win32";
const VISIBLE_CHARACTER = /\S/u;
const present = Schema.is(Schema.String.check(Schema.isPattern(VISIBLE_CHARACTER)));

const isAbsolutePath = (platform: string, path: Path, candidate: string): boolean => {
  const isRootedOnCurrentDrive =
    windows(platform) && ["\\", "/"].includes(path.parse(candidate).root);
  return path.isAbsolute(candidate) && !isRootedOnCurrentDrive;
};

export const resolveDataDirectory = Effect.fn("resolveDataDirectory")(function* (options: {
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string | undefined;
}) {
  const { environment, homeDirectory, platform } = options;
  const path = yield* Path;
  const override = environment[MEMO_HOME_VARIABLE];
  if (override !== undefined) {
    if (!present(override)) {
      return yield* new ConfigurationError({
        message: `${MEMO_HOME_VARIABLE} is blank, but it must be an absolute path`,
      });
    }
    if (!isAbsolutePath(platform, path, override)) {
      return yield* new ConfigurationError({
        message: `${MEMO_HOME_VARIABLE} is \`${override}\`, but it must be an absolute path`,
      });
    }
    return override;
  }
  if (windows(platform)) {
    const local = environment["LOCALAPPDATA"];
    if (!present(local)) {
      return yield* new DataDirectoryUnsetError({
        variables: [MEMO_HOME_VARIABLE, "LOCALAPPDATA"],
      });
    }
    return path.join(local, "Memo");
  }
  if (!present(homeDirectory)) {
    return yield* new DataDirectoryUnsetError({ variables: [MEMO_HOME_VARIABLE, "HOME"] });
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Memo");
  }
  const xdg = environment["XDG_DATA_HOME"];
  const usesXdgDataHome = present(xdg) && isAbsolutePath(platform, path, xdg);
  return usesXdgDataHome
    ? path.join(xdg, "memo")
    : path.join(homeDirectory, ".local", "share", "memo");
});

const FILE_TYPE_NAMES = {
  File: "a file",
  Directory: "a folder",
  SymbolicLink: "a symlink",
  BlockDevice: "a block device",
  CharacterDevice: "a character device",
  FIFO: "a FIFO",
  Socket: "a socket",
  Unknown: "a file of an unknown type",
} as const satisfies Record<File.Type, string>;

export const fileTypeName = (type: File.Type) => FILE_TYPE_NAMES[type];

const verifyDataDirectoryType = Effect.fn("verifyDataDirectoryType")(function* (directory: string) {
  const fileSystem = yield* FileSystem;
  const found = yield* fileSystem.stat(directory).pipe(
    Effect.map((information) => Option.some(information.type)),
    Effect.catchTag("PlatformError", () => Effect.succeedNone),
  );
  const isNotADirectory = Option.isSome(found) && found.value !== "Directory";
  if (isNotADirectory) {
    return yield* new DataDirectoryTypeError({ directory, type: fileTypeName(found.value) });
  }
});

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const values = yield* Config.all({
      [MEMO_HOME_VARIABLE]: Config.String(MEMO_HOME_VARIABLE).pipe(Config.option),
      LOCALAPPDATA: Config.String("LOCALAPPDATA").pipe(Config.option),
      XDG_DATA_HOME: Config.String("XDG_DATA_HOME").pipe(Config.option),
    }).pipe(Effect.mapError((error) => new ConfigurationError({ message: String(error) })));
    const home = yield* userHome;
    const environment = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, Option.getOrUndefined(value)]),
    );
    const directory = yield* resolveDataDirectory({
      platform: process.platform,
      environment,
      homeDirectory: home,
    });
    if (environment[MEMO_HOME_VARIABLE] !== undefined) {
      yield* verifyDataDirectoryType(directory);
    }
    return { directory };
  }),
);

export const hookEnvironment = (log: string) => ({ ...process.env, MEMO_LOG: log });

export const HOOK_COMMAND = Schema.TupleWithRest(Schema.Tuple([Schema.NonEmptyString]), [
  Schema.String,
]);

export const symbolicLinkStatus = (file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.lstat(file)).pipe(
    Effect.map((information) =>
      information.type === "SymbolicLink" ? ("SymbolicLink" as const) : ("NotALink" as const),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("Absent" as const)),
  );

export const isSymbolicLink = (file: string) =>
  Effect.map(symbolicLinkStatus(file), (status) => status === "SymbolicLink");

export const CONFIG_FILE = "config.json";

const JSON_STRING = Schema.fromJsonString(Schema.String);
const hookConfigExample = (command: readonly string[]) =>
  Effect.map(
    Effect.forEach(command, (word) => Schema.encodeEffect(JSON_STRING)(word)),
    (words) => `\`{ "hook": [${words.join(", ")}] }\``,
  ).pipe(Effect.catchTag("SchemaError", (cause) => Effect.die(cause)));

const JSON_OBJECT = Schema.fromJsonString(Schema.JsonObject);
const isJsonList = Schema.is(Schema.Array(Schema.Json));
const decodeHookCommand = Schema.decodeUnknownOption(HOOK_COMMAND);
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/u;
const PLAIN_WORDS = /^[\w@%+=:,./-]+(?: +[\w@%+=:,./-]+)*$/u;

const EXAMPLE_COMMAND = ["bun", "/path/to/check.ts"] as const;

const suggestedCommand = (hook: string, namesAFile: boolean): readonly string[] => {
  const words = hook.trim();
  if (words === "") {
    return EXAMPLE_COMMAND;
  }
  if (namesAFile) {
    return SCRIPT_FILE.test(words) ? ["bun", words] : [words];
  }
  if (!PLAIN_WORDS.test(words)) {
    return ["sh", "-c", hook];
  }
  const split = words.split(/ +/u);
  const isScriptPath = split.length === 1 && SCRIPT_FILE.test(words);
  return isScriptPath ? ["bun", words] : split;
};

const jsonKind = (value: Schema.Json) => {
  if (value === null) {
    return "null";
  }
  if (isJsonList(value)) {
    return "a list";
  }
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
};

export const hookCommand = Effect.fn("hookCommand")(function* (file: string) {
  const fileSystem = yield* FileSystem;
  const path = yield* Path;
  const refused = (fault: string) => new ConfigFileError({ file, fault });
  if (yield* isSymbolicLink(file)) {
    return yield* refused("is a symlink, and memo doesn't follow symlinks");
  }
  if (!(yield* fileSystem.exists(file))) {
    return;
  }
  const { type } = yield* fileSystem.stat(file);
  if (type !== "File") {
    return yield* new ConfigFileTypeError({ file, type: fileTypeName(type) });
  }
  const example = yield* hookConfigExample(EXAMPLE_COMMAND);
  const bytes = yield* fileSystem
    .readFile(file)
    .pipe(
      Effect.catchReason("PlatformError", "PermissionDenied", () =>
        Effect.fail(refused("can't be read, because memo doesn't have permission")),
      ),
    );
  const text = yield* Effect.fromResult(
    Result.mapError(decodeUtf8Strictly(bytes), (offset) =>
      refused(`isn't valid UTF-8 at byte ${offset}`),
    ),
  );
  const config = yield* Schema.decodeEffect(JSON_OBJECT)(text).pipe(
    Effect.mapError(() => refused(`isn't a JSON object like ${example}`)),
  );
  const unknownField = Object.keys(config).find((field) => field !== "hook");
  if (unknownField !== undefined) {
    return yield* refused(
      `has the field \`${unknownField}\`, but \`hook\` is the only field memo reads`,
    );
  }
  const hook = config["hook"];
  if (hook === undefined) {
    return;
  }
  if (typeof hook === "string") {
    return yield* refused(
      `gives the hook as a string instead of a list of words, as in ${yield* hookConfigExample(suggestedCommand(hook, yield* fileSystem.exists(hook.trim())))}`,
    );
  }
  if (!isJsonList(hook)) {
    return yield* refused(
      `gives the hook as ${jsonKind(hook)} instead of a list of words, as in ${example}`,
    );
  }
  if (hook.length === 0) {
    return yield* refused(
      `gives the hook as an empty list, but the list needs at least a command, as in ${example}`,
    );
  }
  const nonString = hook.find((word) => typeof word !== "string");
  if (nonString !== undefined) {
    return yield* refused(
      `gives the hook a word that is ${jsonKind(nonString)}, but every word must be a string, as in ${example}`,
    );
  }
  const words = decodeHookCommand(hook);
  if (Option.isNone(words)) {
    return yield* refused(`gives the hook an empty command, as in ${example}`);
  }
  const hasNulCharacter = words.value.some((word) => word.includes("\u0000"));
  if (hasNulCharacter) {
    return yield* refused(
      "gives the hook a word with a NUL character, which a command can't receive",
    );
  }
  const [command] = words.value;
  const isNameOrAbsolutePath = path.isAbsolute(command) || path.basename(command) === command;
  if (!isNameOrAbsolutePath) {
    return yield* refused(
      `gives the hook command \`${command}\`, which isn't a name on PATH or an absolute path`,
    );
  }
  return words.value;
});
