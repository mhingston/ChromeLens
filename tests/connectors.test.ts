import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ResearchEpisode } from "../packages/domain/src/index.ts";
import { GitOutputConnector, associateOutputsToEpisodes } from "../packages/connectors/src/index.ts";

const run = promisify(execFile);

describe("output connectors", () => {
  it("collects local Git commits without retaining the repository path", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "chromelens-git-"));
    await run("git", ["init", "--quiet"], { cwd: repositoryPath });
    await writeFile(join(repositoryPath, "research.md"), "evidence\n");
    await run("git", ["add", "research.md"], { cwd: repositoryPath });
    await run("git", ["commit", "--quiet", "-m", "Document browser evidence"], {
      cwd: repositoryPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "ChromeLens Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "ChromeLens Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
        GIT_AUTHOR_DATE: "2026-07-18T10:12:00Z",
        GIT_COMMITTER_DATE: "2026-07-18T10:12:00Z",
      },
    });

    const outputs = await new GitOutputConnector(repositoryPath).collect({
      from: "2026-07-18T10:00:00.000Z",
      to: "2026-07-18T10:30:00.000Z",
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      outputType: "git_commit",
      title: "Document browser evidence",
      repository: basename(repositoryPath),
      sourceConnector: "git",
    });
    expect(JSON.stringify(outputs[0])).not.toContain(repositoryPath);
  });

  it("links an output to the nearest episode inside a configurable post-episode window", () => {
    const episode = (episodeId: string, startedAt: string, endedAt: string): ResearchEpisode => ({
      episodeId,
      startedAt,
      endedAt,
      topicLabel: "browser evidence",
      topicConfidence: 0.8,
      activeDurationMs: 10 * 60_000,
      idleDurationMs: 0,
      uniqueDomains: 2,
      uniqueUrls: 3,
      tabSwitchCount: 2,
      domainSwitchCount: 1,
      ideaCount: 0,
      outputCount: 0,
      derivationVersion: 1,
      evidence: [],
      intervalIds: [],
    });
    const episodes = [
      episode("episode-a", "2026-07-18T10:00:00.000Z", "2026-07-18T10:10:00.000Z"),
      episode("episode-b", "2026-07-18T10:30:00.000Z", "2026-07-18T10:40:00.000Z"),
    ];
    const outputs = [{
      outputId: "git:one",
      outputType: "git_commit",
      occurredAt: "2026-07-18T10:14:00.000Z",
      title: "Use event evidence",
      reference: "abc123",
      repository: "chromelens",
      sourceConnector: "git",
      metadata: {},
    }];

    expect(associateOutputsToEpisodes(outputs, episodes, { afterEpisodeMs: 5 * 60_000 })).toEqual([{
      outputId: "git:one",
      episodeId: "episode-a",
      gapMs: 4 * 60_000,
      reason: "output followed the episode within 5 minutes",
      associationVersion: 1,
    }]);
    expect(associateOutputsToEpisodes(outputs, episodes, { afterEpisodeMs: 3 * 60_000 })).toEqual([]);
  });
});
