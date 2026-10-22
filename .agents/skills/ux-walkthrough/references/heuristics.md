# Review heuristics

Look at each screenshot as the user, with only the use case in mind. A finding is anything that
would make them hesitate, misread or give up. Severity:

- **blocker**: they can't complete the use case;
- **friction**: they can, but slowly or unsure;
- **polish**: it works but could read better.

## Reading load

- Can the question of this use case be answered **from this screen alone, without clicking**?
- How many things compete for attention? Aim for at most 7–9 cards per view and at most ~16 words per card at the top levels.
- Is anything shown that doesn't help this level's decision? Move it one level down or into details.
- Is state shown by **encoding** (colour, border, line style, fill, position, icon) rather than text the user must read?
- Do pop-ups, tooltips or toasts demand reading? Prefer showing state in place.

## Orientation

- Is it obvious **where I am** (title, breadcrumb, highlighted location)?
- Is the **way back** obvious, at most one click, plus a keyboard escape and browser back?
- After a click, does the screen change in a way that keeps context (the same object still visible, a smooth transition)?
- Can I jump sideways (to a sibling) without going up first?

## The user's own input

- Is what the user asked for (their requirements, goals) visible, and traceable to the work?
- When the system interprets the user (an agent's reading), can the user confirm or correct it in place?

## Change and feedback

- After the user acts, does the screen confirm it immediately and visibly?
- When someone else acts (an agent, a job), does it show up live, without a reload?
- Can the user point at **any** element and ask for a change? Is a pending request visibly marked until it's handled?

## Consistency and affordance

- Do things that look clickable respond to clicks, and do things that respond look clickable?
- Is the same concept drawn the same way at every level (critical = red border everywhere)?
- Is the legend short and accurate for what's on screen?

## For the agent side (CLI/API outputs)

- Does each output tell the agent what to do next (the command to run, the element it's about)?
- Are refusals explicit about why and how to proceed?
