export const credentialMaskMarker = "［伏せ字］";

export const proposalMaskableFields = [
  "description",
  "acceptance",
  "findings",
  "diffStat",
] as const;

export type ProposalMaskableField = (typeof proposalMaskableFields)[number];

export const proposalScreenedFields = [
  ...proposalMaskableFields,
  "paths",
  "pathViolations",
  "changedPaths",
  "ruleId",
  "ruleName",
] as const;

export type ProposalScreenedField = (typeof proposalScreenedFields)[number];

export const withheldField = { withheld: true } as const;

export function isWithheld(value: unknown): value is typeof withheldField {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "withheld") &&
    (value as typeof withheldField).withheld === true
  );
}

export function proposalField(
  proposal: Record<string, unknown>,
  modelText: Record<string, unknown>,
  field: ProposalScreenedField,
) {
  switch (field) {
    case "description":
    case "acceptance":
    case "findings":
      return modelText[field];
    default:
      return proposal[field];
  }
}

export function proposalWithheldFields(proposal: Record<string, unknown>) {
  const { modelText } = proposal;
  const text =
    modelText && typeof modelText === "object"
      ? (modelText as Record<string, unknown>)
      : {};
  return proposalScreenedFields.filter((field) =>
    isWithheld(proposalField(proposal, text, field)),
  );
}
