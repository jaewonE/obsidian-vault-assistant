export const GENERATION_PLAN_PROMPT = `You are the planning stage of a NotebookLM-to-Anki workflow. Use only the sources selected for this request.

Requested artifact type: \`{{artifact_type}}\`.
Source scope: {{source_scope}}.
Required output language: Korean (ko-KR).
Requested output count: up to {{max_count}} {{artifact_label}}, while aiming to produce as close to {{max_count}} {{artifact_label}} as the selected sources support without repetition or unsupported claims.
If the caller does not explicitly set a deck or deck root, \`deck_name\` itself will become the top-level Anki deck.

Respond with exactly one valid JSON object. Do not use Markdown fences, commentary, citations, or any text before or after the JSON.

The object must have exactly these properties:

{
  "main_topic": "A concise, source-grounded subject name in the dominant source language (2-80 characters).",
  "summary": "A factual 1-3 sentence summary of the selected sources, suitable for the deck description (20-700 characters).",
  "keywords": ["3-10 source-grounded concept strings; each must be non-empty"],
  "deck_name": "A descriptive single Anki child-deck component, 2-60 characters. Use only letters, numbers, dot, underscore, or hyphen. Do not include ::.",
  "tags": ["2-8 short tags. Each tag must contain only letters, numbers, underscore, or hyphen; no spaces or ::."],
  "make_prompt": "A complete, source-grounded instruction for NotebookLM to create the requested artifact type. Repeat the mandatory Korean (ko-KR) output language and the goal to produce as close as possible to {{max_count}} {{artifact_label}} without repetition or unsupported claims, then state audience, scope, difficulty, and card/question format. This will be passed unchanged as the nlm --focus value."
}

For \`quiz\`, make_prompt must request up to {{max_count}} multiple-choice questions, aiming as close to {{max_count}} as possible while retaining non-redundant source-grounded coverage, with one or more correct options, concise Korean rationales for every option, and an optional useful Korean hint. For \`flashcards\`, make_prompt must request up to {{max_count}} cards, aiming as close to {{max_count}} as possible while retaining non-redundant source-grounded coverage, with short Korean front sides and accurate Korean explanatory back sides. Do not invent source facts, do not ask for more sources, and do not include JSON syntax inside make_prompt.`;

export const GENERATION_GLOBAL_PROMPT = `Mandatory output contract for this NotebookLM \`{{artifact_type}}\` artifact. These requirements take priority over every other instruction.

1. Output language: Korean (ko-KR). Write every question, choice, hint, front side, back side, explanation, and rationale in Korean. Do not output English except unavoidable proper names, product names, or code identifiers.
2. Output count: create up to {{max_count}} {{artifact_label}} in total. Aim to produce as close to {{max_count}} {{artifact_label}} as possible; do not stop early when another distinct, well-supported {{artifact_label}} can be made. Coverage quality, non-redundancy, and source grounding take precedence over padding the count.
3. Base every claim on the selected NotebookLM sources. Do not invent facts, citations, or terminology that the sources do not support.
4. Keep wording clear for the audience and scope specified by the source-specific instruction.
5. Do not let the source language determine the output language; translate source-grounded content into Korean.`;
