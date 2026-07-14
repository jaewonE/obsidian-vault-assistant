export const GENERATION_PLAN_PROMPT = `You are the planning stage of a NotebookLM-to-Anki workflow. Use only the sources selected for this request.

Requested artifact type: \`{{artifact_type}}\`.
Source scope: {{source_scope}}.
If the caller does not explicitly set a deck or deck root, \`deck_name\` itself will become the top-level Anki deck.

Respond with exactly one valid JSON object. Do not use Markdown fences, commentary, citations, or any text before or after the JSON.

The object must have exactly these properties:

{
  "main_topic": "A concise, source-grounded subject name in the dominant source language (2-80 characters).",
  "summary": "A factual 1-3 sentence summary of the selected sources, suitable for the deck description (20-700 characters).",
  "keywords": ["3-10 source-grounded concept strings; each must be non-empty"],
  "deck_name": "A descriptive single Anki child-deck component, 2-60 characters. Use only letters, numbers, dot, underscore, or hyphen. Do not include ::.",
  "tags": ["2-8 short tags. Each tag must contain only letters, numbers, underscore, or hyphen; no spaces or ::."],
  "make_prompt": "A complete, source-grounded instruction for NotebookLM to create the requested artifact type. State audience, language, scope, difficulty, and card/question format. This will be passed unchanged as the nlm --focus value."
}

For \`quiz\`, make_prompt must request multiple-choice questions with one or more correct options, concise rationales for every option, and an optional useful hint. For \`flashcards\`, make_prompt must request short front sides and accurate explanatory back sides. Do not invent source facts, do not ask for more sources, and do not include JSON syntax inside make_prompt.`;

export const GENERATION_GLOBAL_PROMPT = `This is the global instruction for every NotebookLM \`{{artifact_type}}\` artifact in this service. It takes priority over the source-specific instruction that follows.

1. Write every question, choice, hint, front side, back side, explanation, and rationale in Korean.
2. Create no more than {{max_count}} {{artifact_label}} in total. Prefer complete, non-redundant coverage over padding the count.
3. Base every claim on the selected NotebookLM sources. Do not invent facts, citations, or terminology that the sources do not support.
4. Keep wording clear for the audience and scope specified by the source-specific instruction.`;
