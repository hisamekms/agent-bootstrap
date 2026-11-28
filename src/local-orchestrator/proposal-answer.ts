import type { CredentialScanner } from "./credential-scan.ts";
import { ContractError, fields, identifier, oneOf } from "./model.ts";
import {
  OrchestratorStoreError,
  permitsPanelAnswer,
  type OrchestratorStore,
  type StoreErrorCode,
} from "./store.ts";
import { screenOperatorProposal } from "./operator-read.ts";
import {
  isWithheld,
  proposalWithheldFields,
  type ProposalMaskableField,
} from "./proposal-screening.ts";
import { candidateDiffStat } from "./tasks.ts";

type ProposalDetails = NonNullable<
  ReturnType<OrchestratorStore["getProposalDetails"]>
>;

export function displayProposal({
  policy: effectivePolicy,
  source: policySource,
  ...proposal
}: ProposalDetails) {
  return { ...proposal, effectivePolicy, policySource };
}

const maxPanelAnswers = 20;

export function parsePanelAnswer(params: unknown) {
  const input = fields(params, ["id", "digest", "decision", "takeover"]);
  const { id, digest, decision, takeover } = input;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw new ContractError();
  if (Object.hasOwn(input, "takeover") && takeover !== true)
    throw new ContractError();
  return {
    id: identifier(id),
    digest,
    decision: oneOf(decision, ["approve", "reject"]),
    ...(takeover === true && { takeover }),
  };
}

export type PanelAnswer = ReturnType<typeof parsePanelAnswer>;
export type PanelAnswerResult =
  { id: string; ok: true } | { id: string; error: { code: StoreErrorCode } };

export async function answerManyFromPanel(
  store: OrchestratorStore,
  directory: string,
  params: unknown,
  scan?: CredentialScanner,
): Promise<PanelAnswerResult[]> {
  const { answers } = fields(params, ["answers"]);
  if (
    !Array.isArray(answers) ||
    answers.length < 1 ||
    answers.length > maxPanelAnswers
  )
    throw new ContractError();
  const parsed = answers.map(parsePanelAnswer);
  if (parsed.some(({ takeover }) => takeover)) throw new ContractError();
  // Batch receipts echo caller IDs, including those that do not exist.
  await scan?.(JSON.stringify(parsed.map(({ id }) => id)));
  const results: PanelAnswerResult[] = [];
  for (const answer of parsed)
    results.push(await answerFromPanel(store, directory, answer, scan));
  return results;
}

export async function proposalDecisionPreview(
  directory: string | undefined,
  proposal: ProposalDetails,
  action: PanelAnswer["decision"] | "show",
  scan?: CredentialScanner,
) {
  const rejectWithScan = action === "reject" && scan !== undefined;
  let diffStat: string | undefined;
  if (proposal.kind === "integration" && !rejectWithScan) {
    if (directory === undefined) throw new ContractError();
    diffStat = await candidateDiffStat(directory, proposal.content, scan);
  }
  return {
    ...(rejectWithScan
      ? { id: proposal.id, digest: proposal.digest, status: proposal.status }
      : displayProposal(proposal)),
    ...(diffStat === undefined ? {} : { diffStat }),
  };
}

type OperatorProposal = Awaited<ReturnType<typeof screenOperatorProposal>>;

// Preserve the aggregate scan of the approval preview, substituting the
// screened display values where the original fields were masked.
function panelApprovalPreview(
  proposal: ProposalDetails,
  display: OperatorProposal,
) {
  const mask = <T>(
    field: ProposalMaskableField,
    raw: T,
    screened: T | { withheld: true },
  ) =>
    display.maskedFields?.includes(field) && !isWithheld(screened)
      ? screened
      : raw;
  const {
    diffSize: _diffSize,
    pinnedReview: _pinnedReview,
    budgets: _budgets,
    pathViolations: _pathViolations,
    ...original
  } = displayProposal(proposal);
  if (proposal.kind === "integration" && display.kind === "integration") {
    const { content } = proposal;
    return {
      ...original,
      diffStat: display.diffStat,
      content: {
        ...content,
        review: {
          ...content.review,
          notes: mask(
            "findings",
            content.review.notes,
            display.modelText.findings ?? undefined,
          ),
        },
      },
    };
  }
  if (proposal.kind === "integration" || display.kind === "integration")
    throw new ContractError();
  const modelText = {
    description: mask(
      "description",
      proposal.content.description,
      display.modelText.description,
    ),
    acceptance: mask(
      "acceptance",
      proposal.content.acceptance,
      display.modelText.acceptance,
    ),
  };
  return { ...original, content: { ...proposal.content, ...modelText } };
}

export async function answerFromPanel(
  store: OrchestratorStore,
  directory: string,
  { id, digest, decision, takeover }: PanelAnswer,
  scan?: CredentialScanner,
): Promise<PanelAnswerResult> {
  try {
    const proposal = store.getProposalDetails(id, {
      includeEvidence: decision === "approve",
    });
    if (!proposal) throw new OrchestratorStoreError("not-found");
    if (proposal.digest !== digest)
      throw new OrchestratorStoreError("stale-digest");
    if (proposal.status !== "pending")
      throw new OrchestratorStoreError("invalid-transition");
    if (!permitsPanelAnswer(proposal.origin, proposal, decision, takeover))
      throw new OrchestratorStoreError("approval-forbidden");
    const expectedRule =
      decision === "approve"
        ? { ruleId: proposal.ruleId, ruleName: proposal.ruleName }
        : undefined;
    if (decision === "approve") {
      const display = await screenOperatorProposal(proposal, directory, scan);
      if (proposalWithheldFields(display).length)
        throw new OrchestratorStoreError("write-failed");
      if (scan)
        await scan(JSON.stringify(panelApprovalPreview(proposal, display)));
    } else {
      const preview = await proposalDecisionPreview(
        directory,
        proposal,
        decision,
        scan,
      );
      await scan?.(JSON.stringify(preview));
    }
    // The store rechecks the digest, transition and policy under its write lock.
    store.decide(
      id,
      {
        digest,
        decision,
        answerer: { kind: "human", channel: "operator-ui" },
        ...(takeover === true && { takeover }),
      },
      expectedRule,
    );
    return { id, ok: true };
  } catch (error) {
    return {
      id,
      error: {
        code:
          error instanceof OrchestratorStoreError ? error.code : "write-failed",
      },
    };
  }
}
