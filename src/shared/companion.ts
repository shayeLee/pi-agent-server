/** Body and reply of `POST /v1/projects/:id/companion/greeting`. */
export type CompanionGreetingInput = {
  persona: { name: string; style: "concise" | "lively" | "formal" };
  dayPart: "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night";
  recent?: { title: string; minutesAgo: number } | null;
};
export type CompanionGreeting = { greeting: string; hint: string };
/** Body and reply of `PUT /v1/companion/persona`; `GET` returns it, or `null` before the first save. */
export type CompanionPersonaRecord = { name: string; style: "concise" | "lively" | "formal"; docked: boolean };
