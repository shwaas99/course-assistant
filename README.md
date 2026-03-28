# Course Assistant

An AI-powered study companion built on Cloudflare's agent infrastructure. Students register their courses, upload their actual course materials, and get a personalized tutor that understands exactly where they are in their coursework — explaining concepts at the right depth, deciding when to push them forward, and generating quizzes grounded in what they have already covered.

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ModuloMonkey65537/cf_ai_course_assistant"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>

---

## How it works

### 1. Register your courses

When you open the app for the first time, tell the assistant what you are studying. You can type naturally — "I'm taking Organic Chemistry, Linear Algebra, and Intro to Computer Science" — and the agent adds each course to your persistent profile automatically. Courses appear in the sidebar instantly, no page reload required.

### 2. Upload your materials

Select any course from the sidebar and upload its syllabus, lecture notes, or textbook chapters as plain-text or Markdown files. The agent reads these materials and keeps them in context whenever you ask questions about that course. Uploaded documents are stored per-course in a Cloudflare Durable Object, so they persist across sessions and are never mixed between subjects.

### 3. Study with a tutor that knows where you are

The assistant tracks your progression through each course based on what you have discussed, what questions you have answered correctly, and what the syllabus indicates comes next. This progression state drives three core behaviors:

**Adaptive explanations** — When you ask the assistant to explain a concept, it calibrates the depth of its answer to what you already know. If you are early in a course it uses foundational language and more worked examples. As your demonstrated understanding grows, explanations become more concise and assume prior knowledge, the way a good professor's lectures evolve over a semester.

**Proactive topic progression** — When the agent determines you have a solid grasp of the current topic — through your questions, your quiz scores, or simply the natural arc of the syllabus — it will suggest moving forward. It decides what the logical next step is based on the ordering of topics in your uploaded materials and the standard pedagogical sequence for the subject, and tells you why it thinks you are ready.

**Contextual quizzing** — Ask the agent to quiz you at any time, or on any topic. It generates multiple-choice questions anchored to your uploaded course texts and calibrated to material you have already covered — not arbitrary trivia, not questions about chapters you have not reached. After each answer it explains whether you were right and why, adding to its model of what you understand.

---

## Cloudflare stack

| Requirement | Implementation |
|---|---|
| **LLM** | Kimi K2.5 via Workers AI (no API key required) |
| **Workflow / coordination** | Cloudflare Workers with Durable Objects for per-user agent state |
| **User input** | React chat UI over WebSocket (real-time streaming) |
| **Memory / state** | Durable Object storage — courses, uploaded materials, and chat history persist across sessions |

---

## Quick start

```bash
npx create-cloudflare@latest --template cloudflare/agents-starter
cd course-assistant
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and tell the assistant what courses you are taking.

---

## Project structure

```
src/
  server.ts    # Chat agent — course state, tool definitions, system prompt
  app.tsx      # Chat UI with course sidebar, file upload, and message stream
  client.tsx   # React entry point
  styles.css   # Styles
```

---

## Key features

**Persistent course profiles** — Each course is stored independently. Switching courses in the sidebar instantly shifts the assistant's context, system prompt, and material grounding to that subject.

**Material-grounded answers** — Every explanation and quiz question is generated from your actual uploaded documents, not the model's general training. If the answer is not in your materials, the assistant says so.

**Session continuity** — The Durable Object retains your full chat history, course list, and uploaded documents. Closing the tab and coming back picks up exactly where you left off.

**Real-time sidebar** — When the AI adds a course on your behalf (for example, after you list your subjects in chat), the sidebar updates immediately without a reload, because the frontend watches for tool completions and re-fetches state as they arrive.

**Study reminders** — Ask the assistant to remind you to review a topic or start studying for an exam. Reminders fire as in-app notifications via Cloudflare's scheduling primitives.

---

## Customization

### Swap the model

The app uses Workers AI by default. To use Claude or GPT-4, install the relevant AI SDK package and update the model reference in `server.ts`:

```bash
npm install @ai-sdk/anthropic
```

```ts
import { anthropic } from "@ai-sdk/anthropic";

const result = streamText({
  model: anthropic("claude-sonnet-4-20250514"),
  // ...
});
```

Add your API key to a `.env` file:

```
ANTHROPIC_API_KEY=your-key-here
```

### Extend the progression model

Course progression is tracked through the agent's Durable Object state. To make it more sophisticated — for example, tracking scores per topic or weighting quiz performance — extend the `CourseState` type in `server.ts` and add fields to the state that gets persisted via `ctx.storage.put`.

### Add more material formats

The current upload flow reads files as plain text. To support PDFs or DOCX files, add a parsing step in the `uploadMaterial` callable method before the text is stored — any text extraction library that runs in a Worker or a separate Worker binding will work.

---

## Deploy

```bash
npm run deploy
```

Your agent is live on Cloudflare's global network. State persists in Durable Object storage, streams resume on disconnect, and the agent hibernates when idle.

---

## Learn more

- [Agents SDK documentation](https://developers.cloudflare.com/agents/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)
- [Build a chat agent tutorial](https://developers.cloudflare.com/agents/getting-started/build-a-chat-agent/)

---

## License

MIT