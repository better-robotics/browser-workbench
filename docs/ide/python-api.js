// Completions for the on-robot Python API. Monaco has no Python language
// server, so instead of the TS worker's IntelliSense we register a
// CompletionItemProvider offering the (small, honest) surface the robot's VM
// exposes: the injected `robot` module + print. Mirror pyvm.c's robot module
// when the firmware API grows.

// Registered once; guarded so repeated IDE opens don't stack providers.
let _registered = false;

export function registerPythonApi(monaco) {
  if (_registered) return;
  _registered = true;
  const K = monaco.languages.CompletionItemKind;

  // Members offered right after "robot."
  const robotMembers = (range) => [
    {
      label: "move", kind: K.Method, range,
      insertText: "move(${1:left}, ${2:right}, ${3:400})",
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "robot.move(left, right, duration_ms) — pulse-bounded motion. Signed magnitudes; the firmware caps duration to the pulse window, so a script can't drive past it.",
      detail: "robot.move(left, right, duration_ms)",
    },
    {
      label: "led", kind: K.Method, range,
      insertText: "led(${1:True})",
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "robot.led(on) — turn the robot's LED on or off.",
      detail: "robot.led(on)",
    },
    {
      label: "rgb", kind: K.Method, range,
      insertText: "rgb(${1:255}, ${2:0}, ${3:0})",
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "robot.rgb(r, g, b) — set the onboard RGB LED, 0–255 per channel.",
      detail: "robot.rgb(r, g, b)",
    },
    {
      label: "sleep", kind: K.Method, range,
      insertText: "sleep(${1:500})",
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "robot.sleep(ms) — pause the script for ms milliseconds.",
      detail: "robot.sleep(ms)",
    },
  ];

  // Top-level names.
  const topLevel = (range) => [
    { label: "robot", kind: K.Module, range, insertText: "robot",
      documentation: "The robot this script runs on. Reaches hardware through the firmware safety floor." },
    { label: "print", kind: K.Function, range, insertText: "print(${1})",
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "print(...) — streams to the editor's output panel over BLE." },
  ];

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      const suggestions = /robot\.\w*$/.test(line) ? robotMembers(range) : topLevel(range);
      return { suggestions };
    },
  });
}
