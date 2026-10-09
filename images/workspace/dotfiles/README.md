# Your workspace

This is your own space to build things with an AI assistant. Nothing here
needs to be installed or configured — it's ready.

## How it works

- **The assistant, next to your files.** Describe what you want in plain
  words, like *"make a page where the team votes on Friday lunch"*. It writes
  and changes the files for you. Pick the assistant under **Settings →
  Assistant**: OpenCode, Claude or Pi.
- **Your files, on the left.** Click one to read it. The **+** adds files or a
  folder from your computer. Everything here is kept, even when the workspace
  pauses. The button next to **+** (or ⌘B) folds them into a slim strip.
- **Preview, on the right.** What you build shows up there by itself. The
  **Preview** button in the top bar shows or hides it (a green dot means your
  app is running); the Preview's own toolbar opens it in a new tab.
- **Your name, bottom left.** Connect GitHub and — if you use it — Claude there.
- **Settings, just above your name.** Light or dark theme, the assistant, a
  terminal, and a safe place for API keys and other secrets — the assistant can
  use them without them ending up in your code.

## Good first things to ask the assistant

- "Build me a simple to-do list app."
- "Read the spreadsheet I just uploaded and make a chart from it."
- "Clone my GitHub project here so we can work on it."

## Things to know

- The workspace pauses after a while without you (30 minutes by default).
  Start it again from the portal — your files and your conversation are
  exactly as you left them.
- A PostgreSQL database is included (`postgres://dev:dev@localhost:5432/dev`).
  If your app needs to remember things, just ask the assistant to use it.
- Only you can open your workspace and your running apps. A running app on
  port 3000 is at `https://3000--<this workspace's address>/`.
