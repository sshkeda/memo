import { Option } from "effect";
import { CliOutput } from "effect/cli";
import type { HelpDoc } from "effect/cli";

const COLUMN_GAP = 3;
const INDENT = "  ";
const NO_SHORT_NAME = "    ";

const columns = (rows: readonly { readonly left: string; readonly right: string }[]) => {
  const width = Math.max(...rows.map((row) => CliOutput.displayWidth(row.left))) + COLUMN_GAP;
  return rows.map(({ left, right }) =>
    `${INDENT}${left}${" ".repeat(width - CliOutput.displayWidth(left))}${right}`.trimEnd(),
  );
};

const flagRows = (flags: readonly HelpDoc.FlagDoc[]) =>
  flags.map((flag) => {
    const shortName = flag.aliases.find((alias) => /^-[^-]$/u.test(alias));
    const longName = `--${flag.name}${flag.type === "boolean" ? "" : ` ${flag.type}`}`;
    return {
      left: `${shortName === undefined ? NO_SHORT_NAME : `${shortName}, `}${longName}`,
      right: Option.getOrElse(flag.description, () => ""),
    };
  });

const formatHelpDoc = (doc: HelpDoc.HelpDoc) => {
  const sections: string[] = [];
  const section = (heading: string, lines: readonly string[]) => {
    if (lines.length > 0) {
      sections.push([`${heading}:`, ...lines].join("\n"));
    }
  };
  if (doc.description !== "") {
    sections.push(doc.description);
  }
  const usage = doc.usage.replace("<subcommand>", "<command>");
  section("Usage", [`${INDENT}${usage}`]);
  const commands = (doc.subcommands ?? []).flatMap((group) => group.commands);
  section(
    "Available Commands",
    commands.length === 0
      ? []
      : columns(
          commands.map((command) => ({
            left: command.name,
            right: command.shortDescription ?? command.description,
          })),
        ),
  );
  const argumentsDoc = doc.args ?? [];
  section(
    "Arguments",
    argumentsDoc.length === 0
      ? []
      : columns(
          argumentsDoc.map((argument) => ({
            left: `${argument.variadic ? `${argument.name}...` : argument.name} ${argument.type}`,
            right: Option.getOrElse(argument.description, () => ""),
          })),
        ),
  );
  const globalFlags = doc.globalFlags ?? [];
  const [flags, inheritedFlags] =
    commands.length > 0 ? [[...doc.flags, ...globalFlags], []] : [doc.flags, globalFlags];
  section("Flags", flags.length === 0 ? [] : columns(flagRows(flags)));
  section("Global Flags", inheritedFlags.length === 0 ? [] : columns(flagRows(inheritedFlags)));
  if (commands.length > 0) {
    const commandPath = usage.slice(0, usage.indexOf(" <command>"));
    sections.push(`Use "${commandPath} <command> --help" for more information about a command.`);
  }
  return sections.join("\n\n");
};

export const helpFormatter = (color: boolean): CliOutput.Formatter => {
  const standard = CliOutput.defaultFormatter({ colors: color });
  return {
    formatHelpDoc,
    formatCliError: standard.formatCliError,
    formatError: standard.formatError,
    formatVersion: standard.formatVersion,
    formatErrors: standard.formatErrors,
  };
};
