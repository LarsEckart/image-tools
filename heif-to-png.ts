#!/usr/bin/env bun

const VERSION = "1.5.0";

import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const DEFAULT_INPUT_DIRECTORY = "~/Downloads";
const DEFAULT_OUTPUT_DIRECTORY = "./outputs";
const PNG_EXTENSION = ".png";
const HISTORY_FILE = join(homedir(), ".config", "heif-to-png", "history.json");
const SUPPORTED_EXTENSIONS = [".heic", ".heif"] as const;

type ConversionSummary = {
  found: number;
  converted: number;
  skipped: number;
  failed: number;
};

type CliOptions = {
  inputDirectory: string;
  outputDirectory: string;
  dryRun: boolean;
  overwrite: boolean;
};

type ConversionHistoryEntry = {
  sourceFilename: string;
  outputPath: string;
  convertedAt: string;
};

type ConversionHistory = Record<string, ConversionHistoryEntry>;

type ConvertFile = (inputPath: string, outputPath: string) => Promise<void>;

export function isSupportedHeifFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(
    extname(filename).toLowerCase() as (typeof SUPPORTED_EXTENSIONS)[number]
  );
}

export function getPngFilenameForSource(sourcePath: string): string {
  const sourceFilename = basename(sourcePath);
  const sourceExtension = extname(sourceFilename);
  return `${basename(sourceFilename, sourceExtension)}${PNG_EXTENSION}`;
}

export function getUniqueFilename(
  baseName: string,
  extension: string,
  reservedNames: ReadonlySet<string>
): string {
  let candidate = `${baseName}${extension}`;
  let counter = 1;

  while (reservedNames.has(candidate)) {
    candidate = `${baseName}-${counter}${extension}`;
    counter++;
  }

  return candidate;
}

export function getTargetOutputFilename(
  sourcePath: string,
  reservedNames: ReadonlySet<string>,
  overwrite: boolean
): string {
  const pngFilename = getPngFilenameForSource(sourcePath);
  if (overwrite) {
    return pngFilename;
  }

  return getUniqueFilename(basename(pngFilename, PNG_EXTENSION), PNG_EXTENSION, reservedNames);
}

export function formatSummary(summary: ConversionSummary, dryRun: boolean): string {
  const convertedLabel = dryRun ? "would convert" : "converted";
  return `Summary: found ${summary.found} / ${convertedLabel} ${summary.converted} / skipped ${summary.skipped} / failed ${summary.failed}`;
}

export function shouldSkipAlreadyConverted(
  historyEntry: ConversionHistoryEntry | undefined,
  outputStillExists: boolean
): boolean {
  return historyEntry !== undefined && outputStillExists;
}

export function expandHomeDirectory(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function showHelp() {
  console.log(`
HEIF to PNG v${VERSION} - Batch-convert HEIF images to PNG with macOS sips

Usage: heif-to-png [options]

Options:
  --input <dir>    Input directory to scan (default: ${DEFAULT_INPUT_DIRECTORY})
  --output <dir>   Output directory for PNGs (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --dry-run        Show what would happen without converting
  --overwrite      Overwrite existing PNGs instead of adding -1, -2 suffixes
  --version        Show version number
  --help           Show this help message

Notes:
  - macOS only
  - Non-recursive: only files directly inside the input directory are processed
  - Uses a global history at ~/.config/heif-to-png/history.json to skip already converted files while their previous PNG still exists

Examples:
  heif-to-png
  heif-to-png --input ~/Downloads --output ./outputs
  heif-to-png --dry-run
  heif-to-png --overwrite
`);
}

function parseCliArguments(args: string[]): CliOptions {
  let inputDirectory = DEFAULT_INPUT_DIRECTORY;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  let dryRun = false;
  let overwrite = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    switch (arg) {
      case "--input": {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--input requires a directory path");
        }
        inputDirectory = value;
        index++;
        break;
      }
      case "--output": {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--output requires a directory path");
        }
        outputDirectory = value;
        index++;
        break;
      }
      case "--dry-run": {
        dryRun = true;
        break;
      }
      case "--overwrite": {
        overwrite = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return {
    inputDirectory: resolve(expandHomeDirectory(inputDirectory)),
    outputDirectory: resolve(expandHomeDirectory(outputDirectory)),
    dryRun,
    overwrite,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("heif-to-png is macOS-only and requires the built-in `sips` command");
  }
}

async function assertDirectoryExists(directoryPath: string, label: string): Promise<void> {
  const directoryStats = await stat(directoryPath);
  if (!directoryStats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directoryPath}`);
  }
}

async function readDirectoryNames(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function loadHistory(): Promise<ConversionHistory> {
  const historyFile = Bun.file(HISTORY_FILE);
  if (!(await historyFile.exists())) {
    return {};
  }

  const historyText = await historyFile.text();
  if (!historyText.trim()) {
    return {};
  }

  const parsed = JSON.parse(historyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid history file: ${HISTORY_FILE}`);
  }

  return parsed as ConversionHistory;
}

async function saveHistory(history: ConversionHistory): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await Bun.write(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
}

async function getFileHash(filePath: string): Promise<string> {
  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(fileBuffer)).digest("hex");
}

export async function convertHeifToPngWithSips(
  inputPath: string,
  outputPath: string
): Promise<void> {
  assertMacOS();

  const processResult = Bun.spawn(["sips", "-s", "format", "png", inputPath, "--out", outputPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await processResult.exited;
  if (exitCode === 0) {
    return;
  }

  const stdout = await new Response(processResult.stdout).text();
  const stderr = await new Response(processResult.stderr).text();
  const details = stderr.trim() || stdout.trim();
  throw new Error(details || `sips exited with status ${exitCode}`);
}

async function processDirectory(
  options: CliOptions,
  convertFile: ConvertFile = convertHeifToPngWithSips
): Promise<ConversionSummary> {
  await assertDirectoryExists(options.inputDirectory, "Input path");

  const directoryEntries = await readdir(options.inputDirectory, { withFileTypes: true });
  const sourceFiles = directoryEntries
    .filter((entry) => entry.isFile() && isSupportedHeifFile(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));

  const summary: ConversionSummary = {
    found: sourceFiles.length,
    converted: 0,
    skipped: 0,
    failed: 0,
  };

  if (sourceFiles.length === 0) {
    console.log(formatSummary(summary, options.dryRun));
    return summary;
  }

  const history = await loadHistory();
  const reservedNames = new Set(await readDirectoryNames(options.outputDirectory));

  if (!options.dryRun) {
    await mkdir(options.outputDirectory, { recursive: true });
  }

  for (const sourceFile of sourceFiles) {
    const inputPath = join(options.inputDirectory, sourceFile);
    const sourceHash = await getFileHash(inputPath);
    const historyEntry = history[sourceHash];
    const outputStillExists = historyEntry
      ? await Bun.file(historyEntry.outputPath).exists()
      : false;

    if (shouldSkipAlreadyConverted(historyEntry, outputStillExists)) {
      summary.skipped++;
      console.log(`Skipping ${sourceFile} -> already converted to ${historyEntry.outputPath}`);
      continue;
    }

    const outputFilename = getTargetOutputFilename(sourceFile, reservedNames, options.overwrite);
    const outputPath = join(options.outputDirectory, outputFilename);

    try {
      if (options.dryRun) {
        console.log(`Would convert ${sourceFile} -> ${outputFilename}`);
      } else {
        console.log(`Converting ${sourceFile} -> ${outputFilename}`);
        await convertFile(inputPath, outputPath);
        history[sourceHash] = {
          sourceFilename: sourceFile,
          outputPath,
          convertedAt: new Date().toISOString(),
        };
        await saveHistory(history);
      }

      summary.converted++;
      if (!options.overwrite) {
        reservedNames.add(outputFilename);
      }
    } catch (error) {
      summary.failed++;
      console.error(`❌ Failed ${sourceFile}: ${formatErrorMessage(error)}`);
    }
  }

  console.log(formatSummary(summary, options.dryRun));
  return summary;
}

// CLI - only run when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    console.log(`heif-to-png ${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help")) {
    showHelp();
    process.exit(0);
  }

  try {
    assertMacOS();
    const options = parseCliArguments(args);

    console.log(
      options.dryRun
        ? `🔍 DRY RUN MODE v${VERSION} - no files will be converted\n`
        : `🚀 Starting heif-to-png v${VERSION}...\n`
    );
    console.log(`📁 Input directory: ${options.inputDirectory}`);
    console.log(`📁 Output directory: ${options.outputDirectory}`);
    console.log(`✍️  Overwrite mode: ${options.overwrite ? "on" : "off"}\n`);

    await processDirectory(options);
  } catch (error) {
    console.error(`❌ ${formatErrorMessage(error)}`);
    process.exit(1);
  }
}
