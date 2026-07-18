import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { OutputEpisodeLink, OutputRecord, ResearchEpisode } from "../../domain/src/index.ts";

const execFileAsync = promisify(execFile);

export interface OutputCollectionRange {
  from: string;
  to: string;
}

export interface OutputConnector {
  readonly connectorId: string;
  collect(range: OutputCollectionRange): Promise<OutputRecord[]>;
}

export interface GitCommandRunner {
  (repositoryPath: string, args: string[]): Promise<string>;
}

export interface OutputAssociationOptions {
  beforeEpisodeMs?: number;
  afterEpisodeMs?: number;
}

export class GitOutputConnector implements OutputConnector {
  readonly connectorId = "git";
  readonly repositoryPath: string;
  readonly repositoryName: string;
  readonly #runGit: GitCommandRunner;

  constructor(repositoryPath: string, runGit: GitCommandRunner = runGitCommand) {
    this.repositoryPath = resolve(repositoryPath);
    this.repositoryName = basename(this.repositoryPath);
    this.#runGit = runGit;
  }

  async collect(range: OutputCollectionRange): Promise<OutputRecord[]> {
    const from = requireIso(range.from, "from");
    const to = requireIso(range.to, "to");
    if (Date.parse(to) <= Date.parse(from)) throw new Error("Git collection range must end after it starts");
    const output = await this.#runGit(this.repositoryPath, [
      "log",
      "--no-merges",
      `--since=${from}`,
      `--until=${to}`,
      "--format=%H%x1f%cI%x1f%s%x1f%an%x00",
    ]);
    const repositoryKey = createHash("sha256").update(this.repositoryPath).digest("hex").slice(0, 12);
    return output.split("\0").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [commit, occurredAt, title, author] = record.split("\x1f");
      if (!commit || !occurredAt) throw new Error("Git returned an unexpected log record");
      return {
        outputId: `git:${repositoryKey}:${commit}`,
        outputType: "git_commit",
        occurredAt: new Date(occurredAt).toISOString(),
        title: title?.trim() || null,
        reference: commit,
        repository: this.repositoryName || null,
        sourceConnector: this.connectorId,
        metadata: author ? { author: author.trim() } : {},
      };
    });
  }
}

export async function collectOutputs(
  connectors: OutputConnector[],
  range: OutputCollectionRange,
): Promise<OutputRecord[]> {
  const batches = await Promise.all(connectors.map((connector) => connector.collect(range)));
  return batches.flat().sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

export function associateOutputsToEpisodes(
  outputs: OutputRecord[],
  episodes: ResearchEpisode[],
  options: OutputAssociationOptions = {},
): OutputEpisodeLink[] {
  const beforeEpisodeMs = requireWindow(options.beforeEpisodeMs ?? 0, "beforeEpisodeMs");
  const afterEpisodeMs = requireWindow(options.afterEpisodeMs ?? 30 * 60_000, "afterEpisodeMs");
  const links: OutputEpisodeLink[] = [];

  for (const output of outputs) {
    const occurredAt = Date.parse(output.occurredAt);
    if (!Number.isFinite(occurredAt)) continue;
    const candidates = episodes.map((episode) => {
      const start = Date.parse(episode.startedAt);
      const end = Date.parse(episode.endedAt);
      const gapMs = occurredAt < start ? start - occurredAt : occurredAt > end ? occurredAt - end : 0;
      const eligible = occurredAt >= start - beforeEpisodeMs && occurredAt <= end + afterEpisodeMs;
      return { episode, gapMs, eligible, end };
    }).filter((candidate) => candidate.eligible)
      .sort((left, right) => left.gapMs - right.gapMs || right.end - left.end);
    const nearest = candidates[0];
    if (!nearest) continue;
    const afterMinutes = Math.round(afterEpisodeMs / 60_000);
    links.push({
      outputId: output.outputId,
      episodeId: nearest.episode.episodeId,
      gapMs: nearest.gapMs,
      reason: nearest.gapMs === 0
        ? "output overlapped the episode"
        : `output followed the episode within ${afterMinutes} ${afterMinutes === 1 ? "minute" : "minutes"}`,
      associationVersion: 1,
    });
  }
  return links;
}

async function runGitCommand(repositoryPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read local Git repository ${basename(repositoryPath)}: ${message}`);
  }
}

function requireIso(value: string, name: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function requireWindow(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60_000) {
    throw new Error(`${name} must be between zero and 24 hours`);
  }
  return value;
}
