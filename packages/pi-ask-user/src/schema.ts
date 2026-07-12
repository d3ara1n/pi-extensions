/**
 * TypeBox schema for the ask_user tool parameters.
 */

import { Type } from "typebox";

const QuestionOptionSchema = Type.Object({
  label: Type.String({
    description: "Short display label for the option (shown on the selection row)",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Short explanation shown under the label (wraps). Add one when the label alone isn't self-explanatory.",
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        "Use this when `description` (a short one-liner) is not enough and the user genuinely benefits from seeing more detail in a side column — e.g. an ASCII layout demo, a code skeleton, a Pro/Cons breakdown, or the reasoning behind why this option is offered and what choosing it entails. Rendered verbatim in a side column (spaces/newlines preserved). Do NOT treat preview as extra text capacity. Every line competes for the user's attention against the option list; only add a preview when the content is worth reading, not just because there's room for more words. If a short `description` already conveys the option, leave preview empty. Most options need only `description`.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  header: Type.String({
    description: "Short question title shown in the panel header, e.g. 'Which layout?'",
  }),
  tab: Type.String({
    description:
      'Short keyword that identifies this question. Shown on the tab bar when there are multiple questions, and returned in the result as the answer\'s prefix. Write it in the user\'s language (e.g. "数据库" or "布局" in a Chinese conversation, "Database" or "Layout" in English), not as a programmatic identifier like "db_choice". Must be unique across questions in one call.',
  }),
  prompt: Type.Optional(
    Type.String({ description: "Optional longer body text shown under the header" }),
  ),
  options: Type.Array(QuestionOptionSchema, {
    description:
      "Available options. Pass 2-4; each needs a short `label` + a `description`, and a `preview` only when a description can't fully convey the option.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "If true, the user may check multiple options (space toggles, enter commits). Default false.",
    }),
  ),
  allowSkip: Type.Optional(
    Type.Boolean({
      description:
        "If false, the user MUST answer before proceeding (Tab/Enter with no selection is blocked). Default true. Use false for required questions.",
    }),
  ),
});

export const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "One or more questions to ask" }),
});
