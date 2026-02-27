/**
 * CI environment detection and context harvesting.
 */

export interface CiContext {
  isCI: boolean;
  source: "cli" | "ci";
  gitRef?: string;
  commitSha?: string;
  runUrl?: string;
}

export function detectCiContext(): CiContext {
  const env = Deno.env.toObject();

  const isCI = !!(
    env.CI ||
    env.GITHUB_ACTIONS ||
    env.GITLAB_CI ||
    env.CIRCLECI ||
    env.JENKINS_URL ||
    env.BUILDKITE
  );

  if (!isCI) {
    return { isCI: false, source: "cli" };
  }

  let gitRef: string | undefined;
  let commitSha: string | undefined;
  let runUrl: string | undefined;

  // GitHub Actions
  if (env.GITHUB_ACTIONS) {
    gitRef = env.GITHUB_REF_NAME || env.GITHUB_REF;
    commitSha = env.GITHUB_SHA;
    if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
      runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    }
  } // GitLab CI
  else if (env.GITLAB_CI) {
    gitRef = env.CI_COMMIT_REF_NAME;
    commitSha = env.CI_COMMIT_SHA;
    runUrl = env.CI_PIPELINE_URL;
  } // CircleCI
  else if (env.CIRCLECI) {
    gitRef = env.CIRCLE_BRANCH || env.CIRCLE_TAG;
    commitSha = env.CIRCLE_SHA1;
    runUrl = env.CIRCLE_BUILD_URL;
  } // Buildkite
  else if (env.BUILDKITE) {
    gitRef = env.BUILDKITE_BRANCH;
    commitSha = env.BUILDKITE_COMMIT;
    runUrl = env.BUILDKITE_BUILD_URL;
  }

  return { isCI: true, source: "ci", gitRef, commitSha, runUrl };
}
