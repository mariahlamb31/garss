import type { SubscriptionInput } from "../types";

const COPY_SUFFIX = "（副本）";

export function buildCopiedSubscriptionName(name: string): string {
  const trimmedName = name.trim();

  if (!trimmedName || trimmedName.endsWith(COPY_SUFFIX)) {
    return name;
  }

  return `${trimmedName}${COPY_SUFFIX}`;
}

export function buildDuplicateSubscriptionDraft(form: SubscriptionInput): {
  editingSubscriptionId: "";
  form: SubscriptionInput;
} {
  return {
    editingSubscriptionId: "",
    form: {
      ...form,
      name: buildCopiedSubscriptionName(form.name),
    },
  };
}
