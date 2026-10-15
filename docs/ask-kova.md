# Ask Kova: how it works, and the rules any AI is held to

Ask Kova is the home's chat assistant. The owner chooses the engine that runs it (Assistant settings): the built-in
parser, a local model, or a cloud one (Anthropic, MiniMax, OpenAI or any OpenAI-compatible server). Engines differ a
lot in how careful they are, so Kova doesn't rely on the model being careful. The **hub** holds every engine to the same
rules, and the owner always sees what really happened.

This page is for anyone, human or AI, changing Ask Kova (`hub/src/assistant/`) or adding a tool to it.

## The path of one request

1. **Built-in parser** (`assistant.ts`). Short, direct commands ("turn off the kitchen lights") run without any AI.
2. **Learned phrases** (`ai.ts`, `assistant.learned`). A request an AI handled cleanly before is replayed locally.
   Follow-ups ("yes", "except Fajr") are never learned, because they only make sense in their own conversation.
3. **The AI engine** (`AiAssistant.ask`). It gets:
   - The system rules (`SYSTEM`, plus `PRAYER_SYSTEM` while prayer times are on).
   - The owner's standing instructions.
   - The home context the owner chose to share (`buildContext`).
   - The recent conversation (`assistant.conversation`, per person, 8 hours).
   - The tools (`TOOLS`).
4. **The toolbox** (`Toolbox.run`) checks every call before it changes anything:
   - It checks permissions.
   - It stops repeated failing calls.
   - It applies the safeguards below.
   - It tells the model, in words, what each call really did.
5. **The hub's check on the reply** (`honestReply`, `withChanges`). The reply may claim only what the tools confirmed.
   The hub adds, in its own words, what changed in each automation.

Every request is logged in `assistant.requests` (text, reply, each tool call with its arguments and result). Read that
log first when someone says "the assistant got it wrong".

## Rules the hub enforces (no engine can get round these)

| Rule | Where | What happens |
|---|---|---|
| **Change only what was asked** | `auto-edit.ts` `unasked`, `update_automation` | A rewrite that swaps the audio of an announcement, or drops speakers or devices, when the owner's words (this message and the turns before it) don't ask for that, is **not saved**. The model is told what to keep and to use `edit`. |
| **Details are edits, not rebuilds** | `update_automation.edit`, `create_automation.from` | `edit: {"then.0.vol": 30}` changes one path and the hub keeps everything else. `from` copies an automation exactly, to split it ("all prayers except Fajr"). |
| **The model sees what it edits** | `buildContext` | When names are shared, each automation is listed in words **and** exactly as saved (`exact: {when, if, then}`), so paths and values are copied, not guessed. |
| **The hub says what changed** | `changeWords`, `withChanges` | Every automation change ends the reply with the hub's own list ("Volume 20% → 30%", "Speakers: Kitchen added"). A slip can't hide in the model's summary. The model gets the same list back, and is told to put back anything that wasn't asked for. |
| **"No" means no** | `DECLINED`, `Toolbox.declined` | A plain "no" / "leave it" / "cancel" after a question changes nothing that turn, whatever the model calls. |
| **No claims without a tool** | `honestReply` | A reply that says something changed when no tool changed anything loses those sentences. The owner reads "I didn't change anything." Before that, the model gets one more chance to actually make the change. |
| **Failures are said** | `honestReply` | A failed call that wasn't fixed puts "Not everything worked" first, then the hub's own Done / Couldn't lists. |
| **Roles** | `TOOL_PERM`, `allows` | A child or guest can't do through Ask Kova what their role can't do in the app. |
| **Undo** | `undos` | Everything one request changed is undone with one tap. |

## Rules the model is told (`SYSTEM`)

These are in the system prompt for every engine. Keep them short, concrete and testable:

- Use only ids from the home context. Never invent one.
- To change something that exists, change only what was asked. Keep the audio, every speaker and device, per-speaker
  levels, times and conditions as they are. Use `edit` for a detail.
- "Except X" leaves X as it was **before this conversation**, not as the model just changed it.
- Numbers the owner gives are the levels they want, not amounts to add.
- Ask one thing at a time. "No" changes nothing. An unclear answer gets one short question back, never a guess.
- Report only what tool results confirmed. Never ask the owner about formats, ids or tool shapes.

## Adding or changing a tool

1. Describe it in `TOOLS` in plain words, with an example of the arguments. Say what it **keeps** as well as what it
   changes.
2. If it changes something that already exists, take the change as a patch (as `edit` does), not as a full
   replacement the model has to rebuild.
3. In the handler:
   - Validate the change (`checkAutomation`, or the tool's own checks).
   - Save it with an undo (`registerUndo`).
   - Log it in Activity with `AI_CAUSE`.
   - Return `{ok, …}` with what really changed, in words.
4. Put the tool in `MUTATING` if it changes anything, so "No" and the claim check cover it.
5. Write a test that **replays a real conversation**. See below.

## Testing with a scripted model

`test/ask-helpers.ts` has `fakeModel`, an OpenAI-compatible server that answers each round from a script, and
`askHome`, a demo home. A script can check the tool results it receives (`lastResults`) and then answer the way a
careless model would. That's how the safeguards are proven. `test/ask-careful.test.ts` replays a real exchange:

> Owner: "The prayer calls except fajr should play at 1.5x the volume it plays now"
>
> The model rebuilt the step from the words it saw. The owner's own recording became another one, and every speaker
> became two. The hub refuses that. The model then copies the automation for Fajr and edits the original. The test
> checks that every other field is unchanged and that the owner reads exactly what changed.

When an owner reports a mistake:

1. Find the request in `assistant.requests`.
2. Write its exchange into a test like that one.
3. Fix the rule in the hub, not only in the prompt, so it holds for every engine.
