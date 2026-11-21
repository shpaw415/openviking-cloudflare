// Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
// SPDX-License-Identifier: AGPL-3.0-only
// Inert data from openviking/system_assets/memory/memory_templates/builtin at
// 000f0765d7ec183886fbabbc22e69bc289cc429d, projected as MemoryTypeSchema.
// Do not execute the upstream template syntax in these strings.

export const memoryTypes = ['profile', 'events', 'preferences', 'entities'] as const
export type MemoryType = typeof memoryTypes[number]

const field = (name: string, description: string, merge_op: 'patch' | 'immutable' | 'replace' = 'patch') => ({
  name, description, merge_op, init_value: null, required: true, type: 'string',
})

function schema(memory_type: MemoryType, definition: {
  description: string; filename_template: string; fields: ReturnType<typeof field>[];
  operation_mode?: string; content_template?: string | null; embedding_template?: string | null;
  overview_template?: string | null;
}) {
  return {
    memory_type, directory: `viking://user/{{ user_space }}/memories${memory_type === 'profile' ? '' : `/${memory_type}`}`,
    enabled: true, operation_mode: 'upsert', stage: 'user', peer_enabled: true,
    content_template: null, embedding_template: null, overview_template: null,
    ...definition,
  }
}

export type MemoryTemplate = ReturnType<typeof schema>

export const defaults: Record<MemoryType, MemoryTemplate> = {
  profile: schema('profile', {
    filename_template: 'profile.md',
    description: `# Role and objective
You are a user-profile modeling expert. Analyze the conversation together with the
existing profile and maintain a compact description of each participant's DURABLE
CURRENT STATE. One profile.md may contain several participants, each under a separate
H1 heading.

Use the same language as the user's conversation. Extract only facts explicitly stated
or confirmed by that participant. Never infer attributes from assistant text, jokes,
hypotheticals, or role-play.

# Profile inclusion rule: current durable states only
A fact belongs in PROFILE only when it describes a current state that is expected to
remain true across future conversations. Allowed examples:
- Basic identity: name, nickname, age, birthday, gender, hometown, current residence,
  nationality, and similarly durable identity facts.
- Current education and career state: current school/degree status, current profession,
  concrete employer when explicitly named, durable qualifications, and established skills.
- Current real-world relationship/family state: marital/relationship status, parents,
  siblings, partner/spouse, and children. Store the relationship state only.
- Long-term health state: chronic conditions, allergies, and lasting physical constraints.

# Route everything else away from profile
Classify every candidate fact before writing it:
- A dated transition, completed occurrence, historical episode, trip, purchase, meeting,
  class, project update, award, accident, or attended/tried/completed/won action -> EVENTS.
- A goal, aspiration, plan, intention, upcoming action, or commitment -> EVENTS when it is
  a concrete commitment; otherwise omit it from profile.
- A like, dislike, value judgment, recommendation, hobby, routine, work/communication
  style, coping method, preferred tool/workflow, or other habitual choice -> PREFERENCES.
- A personality/character summary (kind, resilient, ambitious, supportive, etc.) -> omit
  from profile; do not infer personality from behavior.
- A fact primarily about a pet, place, organization, work, product, or non-participant
  person -> ENTITIES.
- A temporary mood/state, current task, speculative inference, role-play, assistant-only
  claim, or trivial detail -> discard.

A date is only supporting evidence; it does not automatically make a fact an event:
- "Current occupation: Engineer (as of 2023-06-09)" is a durable current state -> PROFILE.
- "Started an engineering job on 2023-06-09" is a transition -> EVENTS.
- "Relationship status: Married (as of 2023-06-09)" -> PROFILE.
- "Held a wedding ceremony on 2023-06-09" -> EVENTS.
- "Education: Master's degree (as of 2023-06-09)" -> PROFILE.
- "Graduated on 2023-06-09" -> EVENTS.

# Incremental update and schema normalization
When an existing profile is provided, process it in this order:

1. Normalize the existing profile first.
   - The required Markdown shape is one H1 per participant followed directly by bullets;
     H2/H3 headings and prose paragraphs are forbidden.
   - If the existing content has extra headings or non-profile content, rewrite the
     COMPLETE content with obj.content.update(...), rather than preserving the old layout
     through many small edits.
   - Remove events, experiences, goals, plans, preferences, personality judgments, entity
     details, temporary states, role-play, unsupported claims, duplicate/paraphrased bullets,
     and stale superseded states.
   - Preserve the durable current-state result of a historical event when appropriate:
     marriage -> current relationship status; graduation -> current education state;
     relocation -> current residence. Do not preserve the event narrative itself.
   - It is valid and expected for a normalized profile to become much shorter.

2. Incorporate current durable states from the conversation.
   - Add only genuinely new current-state facts.
   - Merge semantic duplicates into one concise bullet.
   - For conflicting mutable states (occupation, residence, relationship status, education),
     replace the old state with the latest confirmed value; never retain state history here.

3. Preserve untouched valid information.
   - Existing compliant current-state bullets remain even when the current conversation does
     not repeat them. Do not rebuild a profile from only the latest conversation.

# Required Markdown format
- One H1 heading with only the participant's name, followed directly by bullet statements.
- Repeat the H1 + bullet structure for each participant in the same profile.md.
- Do not output H2/H3 headings, JSON, prose paragraphs, tables, labels, or category names.
- Every bullet MUST end with the latest confirmation date in the exact form
  "(as of YYYY-MM-DD)". "As of" means the participant most recently stated or confirmed
  that the state was true; it is not necessarily the event date or file-write date.
- Preserve an old valid bullet's existing as-of date when no newer confirmation exists;
  never stamp all bullets with today's date merely because the file is rewritten.
- Use concise, self-contained declarative bullets, normally under 30 words excluding the
  trailing as-of marker. A compact profile is preferred; merge redundancy before removing
  valid current-state facts.
`,
    fields: [field('content', `Complete Markdown profile containing only durable current-state facts.

Preserve this exact shape for every participant:

# <Person name>
- <Current stable fact> (as of YYYY-MM-DD)
- <Current stable fact> (as of YYYY-MM-DD)

Repeat the H1 + bullets for additional participants. Do not output H2/H3 headings,
JSON, prose paragraphs, category labels, event timelines, historical narratives,
goals/plans, preferences, personality judgments, entity details, or temporary states.

If existing content violates this schema, use obj.content.update(...) to replace the
COMPLETE field with a normalized version. Preserve all untouched valid current-state
facts, but delete non-profile content, merge semantic duplicates, and replace stale
conflicting states with the latest confirmed state.

Every bullet MUST end with (as of YYYY-MM-DD), using the date when that participant
most recently stated or confirmed the fact. Preserve the existing date when there is
no newer confirmation; never use the file-update date merely because of a rewrite.
`)],
  }),
  events: schema('events', {
    filename_template: '{{ extract_context.get_year(ranges) }}/{{ extract_context.get_month(ranges) }}/{{ extract_context.get_day(ranges) }}/{{ event_name }}.md',
    operation_mode: 'add_only',
    content_template: `{% set resource_event_content = extract_context.get_resource_event_content(ranges, summary) %}
{% if resource_event_content %}
{{ resource_event_content }}
{% else %}
# Summary
{{ summary }}
# {{extract_context.get_first_message_time_with_weekday_from_ranges(ranges|default(''))|default('N/A')}} ChatLog:
{{ extract_context.get_event_content(ranges, summary, 0) }}
{% endif %}
`,
    embedding_template: `EventName: {{ event_name }}
Goal: {{ goal }}
{{ content }}`,
    overview_template: `# Events Overview
{% for item in items %}
- [{{ item.file_content.summary|default(item.file_name, true) }}](./{{ item.file_name }})
{% endfor %}`,
    description: `# Guidelines
- Each event must be atomic: capture exactly one real-world occurrence, decision, commitment, arrangement, proposal, progress update, or result.
- Prefer precise, small events over comprehensive narratives. Do not merge independent sub-events just because they appear in the same chat.
- The summary must include the key fact that makes the event worth remembering, especially commitments, agreements, proposals, confirmations, schedule changes, ownership assignments, and outcomes that may be referenced later.
- If there is a time expression (such as "yesterday"), convert it to a specific year-month-day date based on when the event occurred.
- Convert dialogue into indirect speech and preserve the concrete facts, who said/did what, and the outcome.
- Use a third-person perspective.
- Record content that mentions time.
- Each event should represent a REAL-WORLD occurrence discussed in the conversation (e.g., a pottery class, a road trip, a meteor shower), NOT the conversation itself. A conversation is the medium, not the event.
- Split multi-topic conversations into separate events by topic.
- Even within one continuous topic, create separate events when ANY of the following changes:
  - the main goal or subject
  - the time anchor
  - the decision, proposal, or commitment
  - the responsible person or participants
  - the outcome or status
- It is allowed and encouraged to extract multiple events from one continuous block of messages when that block contains multiple independent decisions, commitments, plans, or results.
- Do NOT name events after who was chatting. Name them after what specifically happened.
- Avoid broad umbrella events such as "team arrangement", "project discussion", "weekend plan", or "meeting chat" when the conversation actually contains multiple smaller actionable sub-events.

# Granularity Examples
## Bad Example
Conversation facts:
- They proposed having dinner on Friday.
- They confirmed a meeting for next Monday.
- Xiaoming promised to bring the projector.
Bad extraction:
- event_name: 团队安排
  summary: They discussed team arrangements, including dinner, next week's meeting, and equipment preparation.
Why bad:
- It merges a proposal, a schedule confirmation, and a commitment into one coarse event.

## Good Example
Good extraction:
- event_name: 周五聚餐提议
  summary: A Friday dinner was proposed.
- event_name: 下周一会议确认
  summary: A meeting for next Monday was confirmed.
- event_name: 投影仪携带承诺
  summary: Xiaoming committed to bring the projector.
Why good:
- Each event contains one decision/proposal/commitment only.

## Bad Example
Conversation facts:
- The launch was postponed to June 3.
- Lina became the owner of the release checklist.
- Work on the sync feature was blocked by a dependency issue.
Bad extraction:
- event_name: 发布调整
  summary: They adjusted the release plan, including postponing the launch, assigning Lina as owner, and handling a dependency issue.
Why bad:
- It merges a schedule change, an ownership assignment, and a blocker into one coarse event.

## Good Example
Good extraction:
- event_name: 上线延期确认
  summary: The launch was postponed to 2026-06-03.
- event_name: 清单负责人确认
  summary: Lina was assigned as the owner of the release checklist.
- event_name: 同步依赖阻塞
  summary: The sync feature was blocked by a dependency issue.
Why good:
- Schedule change, ownership, and blocker are three independent events.

## Bad Example
Conversation facts:
- Work started on the sync feature.
- The work was blocked by a dependency issue.
- Work resumed after the dependency was fixed.
- The rollout completed later that week.
Bad extraction:
- event_name: 同步功能进展
  summary: Work on the sync feature moved forward from start to blockage, recovery, and rollout.
Why bad:
- It compresses a multi-stage timeline into one coarse event.

## Good Example
Good extraction:
- event_name: sync_feature_started
  summary: Work on the sync feature started.
- event_name: dependency_blocker_hit
  summary: Work on the sync feature was blocked by a dependency issue.
- event_name: sync_work_resumed
  summary: The sync feature work resumed after the dependency was fixed.
- event_name: rollout_completed
  summary: The rollout of the sync feature was completed later that week.
Why good:
- A start, a blocker, a resumption, and a completion are four separate status changes and should be stored as four atomic events.
`,
    fields: [
      field('event_name', `Output a concise name for exactly one atomic real-world event.
Rules:
1. Must be written in {{ language }};
2. {% if language == 'en' %}Use lowercase with underscores instead of spaces, maximum 3 words;{% else %}Keep it concise and natural in {{ language }};{% endif %}
3. Never include any date, time, year or number;
4. Must name one specific proposal, decision, commitment, arrangement, progress update, or result — not a broad topic bucket;
5. Names ending with _chat, _talk, _conversation, _catchup, _discussion are forbidden;
6. Patterns like "person_chat", "chat_about_xxx", "daily_talk" are forbidden;
7. Broad names like "team arrangement", "project discussion", "weekend plan", "meeting topic" are forbidden if the source actually contains smaller sub-events;
8. Output only the event name, no extra explanation.
`, 'immutable'),
      field('goal', 'Summarize the purpose of the content in 5 words or less\n'),
      field('summary', `Based on the content of the above fields, compile a description to outline the complete Fact content.
Use specific year-month-day dates instead of vague terms such as yesterday, last week, and tomorrow.
`),
      field('ranges', `Conversation message index ranges to extract. Supports:
- Range: "start-end" (e.g., "0-3" means messages 0 to 3)
- Single index: "N" (e.g., "7" means only message 7)
- Mixed: "0-3,7,15-20" (ranges and single indices combined)
For events, ranges MUST include at least one user-role message that states or supports the event.
If an assistant message confirms, normalizes, or completes the event, include both the originating user message and the assistant message.
Never output assistant-only ranges for events.
`, 'immutable'),
    ],
  }),
  preferences: schema('preferences', {
    filename_template: '{{ user|lower }}/{{ topic|lower }}.md',
    embedding_template: '{{ user }}\n\n{{ topic }}\n\n{{ content }}',
    overview_template: `# Preferences Overview
{% if items %}**User:** {{ items[0].file_content.user|default(directory_name, true) }}
**Topic:** {{ items[0].file_content.topic|default(items[0].file_name, true) }}{% endif %}
{% for item in items %}
- [{{ item.file_content.topic|default(item.file_name, true) }}](./{{ item.file_name }})
{% endfor %}`,
    description: `User preference memory - captures "what the user likes/dislikes or is accustomed to".
Extract specific preferences the user has expressed across conversations.
Each preference should be about a specific topic (not generic).
Topics can be: code style, communication style, tools, workflow, food, commute, etc.
Store different topics as separate memory files, do NOT mix unrelated preferences.
`,
    fields: [
      field('user', 'Username for the preference owner\n', 'immutable'),
      field('topic', `Preference topic written in {{ language }}.
{% if language == 'en' %}Use lowercase with underscores, max 3 words.{% else %}Keep the topic concise and natural in {{ language }}.{% endif %}
Preference topic used to uniquely identify this preference memory.
Should be a semantic topic description such as "Python code style", "Communication style", "Food preference", "Commute preference", etc.
This topic is an identity component together with user. Merge only true aliases for
the same owner's same behavioral choice dimension. Related dimensions may share words
but remain separate; for example, preferred movie genres and preferred games are not
one preference merely because both are entertainment.
`, 'immutable'),
      field('content', `Preference content in Markdown format describing "what the user prefers/is accustomed to".
Write one concise bullet per distinct, reusable preference; omit exact duplicates,
events, dates, and plans. Preserve the specific choice, list members, conditions,
exceptions, and user-stated reason or emotional meaning when they make the preference
answerable or distinguish it from nearby preferences.
Example:
- Prefers concise written updates with decisions and next actions.
- Chooses lightweight tools when they cover the workflow.
`),
    ],
  }),
  entities: schema('entities', {
    filename_template: '{{ category|lower }}/{{ name|lower }}.md',
    embedding_template: '{{ category }}\n\n{{ name }}\n\n{{ content }}',
    overview_template: `# Entities Overview
{% if items %}**Category:** {{ items[0].file_content.category|default(directory_name, true) }}{% endif %}
{% for item in items %}
- [{{ item.file_content.name|default(item.file_name, true) }}](./{{ item.file_name }})
{% endfor %}`,
    description: `Third-party entity memory: stable cards for real people, organizations, places,
works, media, products, animals/pets, programs, activities, and concepts the
user mentions. Store what the entity is and its durable relations.
Entity identity is the referenced real-world object, not its category or semantic
similarity. Merge only explicit aliases of the same object. Distinct people, pets,
works, artworks, products, possessions, places, events, and activities remain separate
even when they share a theme, owner, participants, appearance, or use.
`,
    fields: [
      field('category', `Category written in {{ language }}.
{% if language == 'en' %}Use lowercase with underscores, max 3 words.{% else %}Keep the topic concise and natural in {{ language }}.{% endif %}
`, 'replace'),
      field('name', '- Entity name in Chinese or English. If English, use lowercase with underscores, max 3 words.\n', 'replace'),
      field('content', `Compact Markdown card for a third-party entity.

Required shape: one H1 display name, then one plain sentence on the next line;\x20
it must not start with "-", "*", or "1.".\x20
Then 2-4 H2 sections, every H2 body must be a bullet list, 1-5 bullets per section;\x20
do not write paragraph bodies under H2. Pick natural headings
such as Description, Purpose, Role, Significance, Values, or Relations.

Include compact but answerable entity facts. Prefer stable facts, but preserve
exact user-stated facts that may be asked later: identity, origin, relationship
or family status, counts, roles, skills, hobbies, favorite works/artists, and notable
dated facts tied to this entity.

For people, include a Key Facts section when useful. Do not drop exact names,
counts, dates, places, titles, family relations, or recurring hobbies just to
generalize. Keep one-off facts only when they are concrete and likely useful
for future who/what/when/where/how-long questions.

Keep it readable: 6-14 bullets / about 1200 chars is a soft target. Never drop or
generalize a distinct answerable fact to meet it. When updating, deduplicate exact or
paraphrased facts about this same entity and preserve every other existing atomic fact
unless contradicted.
`),
    ],
  }),
}
