import { escapeTerminalControls } from "./analysis.ts";
import type { CredentialScanner } from "./credential-scan.ts";
import { candidateDiffStat } from "./tasks.ts";
import type { OrchestratorStore } from "./store.ts";

type ProposalDetails = NonNullable<
  ReturnType<OrchestratorStore["getProposalDetails"]>
>;

function proposalPolicy({
  gate,
  policy,
  source,
  loosening,
  humanApprovalRequired,
  humanAnswerRequired,
}: ProposalDetails) {
  return {
    gate,
    effectivePolicy: policy,
    policySource: source,
    loosening,
    humanApprovalRequired,
    humanAnswerRequired,
  };
}

export function operatorStatus(store: OrchestratorStore) {
  const proposals = store.listProposals();
  const goals = store.listGoals();
  const pending = proposals
    .filter(({ status }) => status === "pending")
    .map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      ...(proposal.kind === "integration"
        ? {
            goalId: proposal.content.goalId,
            taskId: proposal.content.taskId,
          }
        : { title: proposal.content.title }),
      ...proposalPolicy(store.getProposalDetails(proposal.id)!),
    }));
  const { recentExecutions, recentTasks } = store.getHostApiStatus();
  return {
    counts: {
      goals: goals.length,
      tasks: goals.reduce(
        (count, goal) => count + store.listTasks(goal.id).length,
        0,
      ),
      proposals: proposals.length,
      pending: pending.length,
    },
    pending,
    recentExecutions,
    recentTasks,
  };
}

export async function operatorProposal(
  store: OrchestratorStore,
  stateDirectory: string,
  id: string,
  scan?: CredentialScanner,
) {
  const proposal = store.getProposalDetails(id);
  if (!proposal) return null;
  const diffStat =
    proposal.kind === "integration"
      ? (await candidateDiffStat(stateDirectory, proposal.content, scan))
          .split("\n")
          .map(escapeTerminalControls)
          .join("\n")
      : null;
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    digest: proposal.digest,
    ...proposalPolicy(proposal),
    diffStat,
  };
}
