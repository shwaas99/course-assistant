import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  type ModelMessage
} from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Course = {
  name: string;
  materials: string[];
};

type CourseState = {
  courses: Course[];
  activeCourse: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

function getActiveCourse(state: CourseState): Course | null {
  if (!state.activeCourse) return null;
  return state.courses.find((c) => c.name === state.activeCourse) ?? null;
}

function buildMaterialsContext(course: Course | null): string {
  if (!course || course.materials.length === 0) {
    return "No course materials uploaded yet.";
  }
  const combined = course.materials.join("\n\n---\n\n");
  return combined.length > 8000 ? combined.slice(0, 8000) + "\n\n[truncated]" : combined;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  #courseState: CourseState = {
    courses: [],
    activeCourse: null
  };

  async onStart() {
    const saved = await this.ctx.storage.get<CourseState>("courseState");
    if (saved) this.#courseState = saved;

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  async #saveCourseState(next: CourseState) {
    this.#courseState = next;
    await this.ctx.storage.put("courseState", next);
  }

  // ── Callable RPC methods (client-facing) ───────────────────────────────────

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async addCourse(name: string): Promise<CourseState> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Course name cannot be empty.");
    const already = this.#courseState.courses.some((c) => c.name === trimmed);
    if (already) return this.#courseState;
    const next: CourseState = {
      ...this.#courseState,
      courses: [...this.#courseState.courses, { name: trimmed, materials: [] }]
    };
    await this.#saveCourseState(next);
    return next;
  }

  @callable()
  async selectCourse(name: string): Promise<CourseState> {
    const exists = this.#courseState.courses.some((c) => c.name === name);
    if (!exists) throw new Error(`Course "${name}" not found.`);
    const next: CourseState = { ...this.#courseState, activeCourse: name };
    await this.#saveCourseState(next);
    return next;
  }

  @callable()
  async removeCourse(name: string): Promise<CourseState> {
    const next: CourseState = {
      courses: this.#courseState.courses.filter((c) => c.name !== name),
      activeCourse:
        this.#courseState.activeCourse === name
          ? null
          : this.#courseState.activeCourse
    };
    await this.#saveCourseState(next);
    return next;
  }

  @callable()
  async uploadMaterial(
    courseName: string,
    text: string,
    label: string
  ): Promise<CourseState> {
    const courses = this.#courseState.courses.map((c) => {
      if (c.name !== courseName) return c;
      return { ...c, materials: [...c.materials, `[${label}]\n${text}`] };
    });
    const next: CourseState = { ...this.#courseState, courses };
    await this.#saveCourseState(next);
    return next;
  }

  @callable()
  async getCourseState(): Promise<CourseState> {
    return this.#courseState;
  }

  // ── Main chat handler ──────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const activeCourse = getActiveCourse(this.#courseState);
    const materialsContext = buildMaterialsContext(activeCourse);
    const courseList =
      this.#courseState.courses.map((c) => c.name).join(", ") || "none";

    const systemPrompt = `You are a dedicated course assistant that helps students study. You directly manage the student's course list — you are the system, not a middleman.

## Student's current courses
${courseList}

## Currently active course
${activeCourse ? activeCourse.name : "None selected."}

## Course materials (active course only — use these to answer questions)
${materialsContext}

## How to handle every situation — follow these exactly:

SITUATION: Student says "add my courses", "set up my courses", or similar with no course names given.
ACTION: Reply by asking what courses they are taking this semester. Wait for their response.

SITUATION: Student lists course names (e.g. "Calculus, Biology, CS101" or "I'm taking X and Y").
ACTION: Call addCourseByName once for EACH course they mentioned. Do not ask for confirmation first — just add them all immediately, then confirm what was added and ask if they want to upload materials like a syllabus or textbook.

SITUATION: Student says "switch to [course]" or "let's work on [course]".
ACTION: Call switchCourse immediately with that course name.

SITUATION: Student asks "quiz me" or "quiz me on [topic]".
ACTION: Call generateQuiz with the topic and number of questions.

SITUATION: Student asks to explain a concept or topic.
ACTION: Answer directly using the course materials above. If no materials are uploaded, answer from general knowledge and mention that uploading a syllabus would give more tailored answers.

SITUATION: Student asks for a summary of a chapter or topic.
ACTION: Call summariseTopic.

SITUATION: Student asks for a study reminder or exam alert.
ACTION: Call scheduleTask.

## Non-negotiable rules:
- NEVER tell the student to enroll elsewhere or use another system. You add courses directly with addCourseByName.
- NEVER refuse to add a course. Any subject name is valid.
- NEVER say you "don't have the ability" to add courses. You have addCourseByName — use it.
- After adding courses, always ask if they want to upload their syllabus or textbook for each course.
- If no course is active and the student asks a subject question, ask which course to focus on, then call switchCourse.
- Be warm, direct, and concise. No unnecessary caveats or disclaimers.

${getSchedulePrompt({ date: new Date() })}`;

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemPrompt,
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // ── MCP tools ────────────────────────────────────────────────────────
        ...mcpTools,

        // ── Course management ────────────────────────────────────────────────

        addCourseByName: tool({
          description:
            "Add a single course to the student's course list. Call this once per course name. When the student lists multiple courses, call this tool multiple times — once for each course.",
          inputSchema: z.object({
            courseName: z
              .string()
              .describe(
                "The name of the course to add, exactly as the student stated it."
              )
          }),
          execute: async ({ courseName }) => {
            const trimmed = courseName.trim();
            const already = this.#courseState.courses.some(
              (c) => c.name === trimmed
            );
            if (already) return `"${trimmed}" is already in your course list.`;
            await this.addCourse(trimmed);
            return `Added "${trimmed}".`;
          }
        }),

        switchCourse: tool({
          description:
            "Switch the active course so that explanations, quizzes, and summaries focus on it. If the course does not exist in the list yet, it will be added automatically.",
          inputSchema: z.object({
            courseName: z
              .string()
              .describe("The name of the course to switch to.")
          }),
          execute: async ({ courseName }) => {
            const trimmed = courseName.trim();
            const exists = this.#courseState.courses.some(
              (c) => c.name === trimmed
            );
            if (!exists) await this.addCourse(trimmed);
            await this.selectCourse(trimmed);
            return `Now focused on "${trimmed}".${
              !exists ? " Added it to your course list." : ""
            } Ask me anything, or say "quiz me" to get started.`;
          }
        }),

        listCourses: tool({
          description:
            "List all courses the student has added and show which one is currently active.",
          inputSchema: z.object({}),
          execute: async () => {
            const { courses, activeCourse } = this.#courseState;
            if (courses.length === 0)
              return "No courses added yet. Ask the student what courses they are taking.";
            return courses
              .map(
                (c) =>
                  `${c.name}${c.name === activeCourse ? " (active)" : ""} — ${c.materials.length} material(s)`
              )
              .join("\n");
          }
        }),

        // ── Learning tools ───────────────────────────────────────────────────

        generateQuiz: tool({
          description:
            "Generate a multiple-choice quiz on a topic from the active course. Each question has four options labelled A through D.",
          inputSchema: z.object({
            topic: z
              .string()
              .describe("The topic or chapter to base the quiz on."),
            numQuestions: z
              .number()
              .min(1)
              .max(10)
              .default(5)
              .describe("How many questions to generate.")
          }),
          execute: async ({ topic, numQuestions }) => {
            const course = getActiveCourse(this.#courseState);
            if (!course)
              return "No course is selected. Please switch to a course first.";
            const hasMaterials = course.materials.length > 0;
            return [
              `Generate ${numQuestions} multiple-choice questions about "${topic}" for ${course.name}.`,
              hasMaterials
                ? "Base every question strictly on the uploaded course materials in your context."
                : "No materials uploaded yet — use your general knowledge for this subject.",
              "",
              "Format each question exactly like this:",
              "Q1. [question text]",
              "A) ...   B) ...   C) ...   D) ...",
              "Answer: [letter] — [one-sentence explanation]"
            ].join("\n");
          }
        }),

        summariseTopic: tool({
          description:
            "Produce a concise bullet-point summary of a topic or chapter from the active course materials.",
          inputSchema: z.object({
            topic: z.string().describe("The topic or chapter to summarise.")
          }),
          execute: async ({ topic }) => {
            const course = getActiveCourse(this.#courseState);
            if (!course) return "No course selected.";
            return `Summarise "${topic}" for ${course.name} using the materials in your context. Use clear bullet points. If no materials are available, summarise from general knowledge and note that.`;
          }
        }),

        // ── Scheduling ───────────────────────────────────────────────────────

        scheduleTask: tool({
          description:
            "Schedule a study reminder or exam alert for the student.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") return "Not a valid schedule.";
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type.";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Reminder set: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all upcoming study reminders and exam alerts.",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No reminders scheduled.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled reminder by its ID.",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel.")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Reminder ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling: ${error}`;
            }
          }
        }),

        // ── Utility ──────────────────────────────────────────────────────────

        getWeather: tool({
          description: "Get the current weather for a city.",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        getUserTimezone: tool({
          description:
            "Get the user's local timezone from their browser. Handled client-side — no execute needed.",
          inputSchema: z.object({})
        }),

        calculate: tool({
          description:
            "Perform arithmetic. Useful for statistics, physics, economics, or any quantitative course.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            if (operator === "/" && b === 0) return { error: "Division by zero" };
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Scheduled task execution ───────────────────────────────────────────────

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;