// The code the patcher adds to Cursor's workbench file.
//
// It runs inside Cursor's window and calls Cursor's own inline diff service, so the hunks,
// the Keep / Undo buttons, the file bar and Ctrl+Z all behave exactly like Cursor's agent diffs.
// It only uses string IDs and method names, which survive Cursor's minification.
// The two minified names it needs are filled in by the patcher:
//   __CREATE_DECORATOR__  the function that turns a service ID into a lookup key
//   __COMMANDS_REGISTRY__ the global list of commands
//
// String.raw keeps backslashes as typed (needed for the regex below).
export const PAYLOAD_TEMPLATE = String.raw`;(() => {
  try {
    const createDecorator = __CREATE_DECORATOR__;
    const commandsRegistry = __COMMANDS_REGISTRY__;
    const patchVersion = __PATCH_VERSION__;
    // Asking again for the same ID returns the same key Cursor uses for that service.
    const services = {
      inlineDiffs: createDecorator("inlineDiffService"),
      textFiles: createDecorator("textFileService"),
      textModels: createDecorator("textModelService"),
      files: createDecorator("fileService"),
      editors: createDecorator("editorService"),
    };
    // IDs of diffs this patch made. Cursor's own agent diffs are never touched by the Undo handling below.
    const ourDiffs = new Set();
    let isListeningForFinishedUndo = false;

    const splitLines = (text) => text.split(/\r\n|\r|\n/);
    const haveSameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);
    const isSameFile = (a, b) => a.toString() === b.toString();
    const makeId = () => globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);

    // Remember finished diffs too: Ctrl+Z can bring a diff back under the same ID.
    // Only the oldest are dropped, so the list can't grow forever.
    const rememberOurDiff = (diffId) => {
      ourDiffs.add(diffId);
      while (ourDiffs.size > 1000) ourDiffs.delete(ourDiffs.values().next().value);
    };

    // What Cursor does when Undo finishes one of its own agent's diffs, done for ours.
    // Undo on a single hunk only changes the editor. Once Undo leaves no hunks (Undo File, or
    // Undo on the last hunk), the file is saved, or deleted if the agent created it.
    // Keep never saves: the agent's text is already on disk. (Checked against Cursor 3.29.)
    const listenForFinishedUndo = (accessor) => {
      if (isListeningForFinishedUndo) return;
      isListeningForFinishedUndo = true;
      const textFiles = accessor.get(services.textFiles);
      const files = accessor.get(services.files);
      const editors = accessor.get(services.editors);
      const afterUndo = async ({ uri, diffId, inlineDiff }) => {
        if (!ourDiffs.has(diffId)) return;
        try {
          const wasNewFile = Boolean(inlineDiff) && inlineDiff.originalTextLines.length === 0;
          if (wasNewFile) {
            await textFiles.revert(uri, { soft: false }).catch(() => {});
            if (await files.exists(uri)) await files.del(uri, { useTrash: true });
            for (const editor of editors.findEditors(uri)) await editors.closeEditor(editor);
            return;
          }
          // Same options Cursor uses for its agent (reason 1 = an explicit save).
          await textFiles.save(uri, { reason: 1, force: true });
        } catch (error) {
          console.error("[agent-diff] could not finish Undo:", error);
        }
      };
      const inlineDiffs = accessor.get(services.inlineDiffs);
      inlineDiffs.onDidRejectPartialDiff((event) => {
        if (!event.isDone) return;
        afterUndo({ uri: event.diffInfo.uri, diffId: event.diffInfo.diffId, inlineDiff: event.inlineDiff });
      });
      inlineDiffs.onDidRejectDiff((event) => {
        afterUndo({ uri: event.uri, diffId: event.diffId, inlineDiff: event.inlineDiff });
      });
    };

    // Cursor treats a text edit outside every hunk of an agent diff as already kept: it adds the
    // edit to the diff's original text, so the edit never shows as a hunk. That is also why
    // Ctrl+Z after Undo or Undo File brings the text back without its hunks. Cursor only does
    // this for diffs that belong to an agent chat, so the same steps are added here for ours.
    // (Copied from the agent-chat branch of Cursor's processOverlapEdit, Cursor 3.29.)
    const addEditOutsideHunksToOriginal = (handler, edit, eol) => {
      // Cursor's own edits while applying Keep or Undo are not user edits.
      if (handler.isApplyingPartialRejectEdit) return;
      const isCursorsOwnEdit = (handler.lastEdits || []).some((own) =>
        own.range.startLineNumber === edit.range.startLineNumber && own.range.startColumn === edit.range.startColumn &&
        own.range.endLineNumber === edit.range.endLineNumber && own.range.endColumn === edit.range.endColumn &&
        (own.text ?? "") === edit.text);
      if (isCursorsOwnEdit) return;

      const diff = handler.inlineDiff;
      const firstLine = edit.range.startLineNumber - diff.currentRange.startLineNumber + 1;
      const lastLine = edit.range.endLineNumber - diff.currentRange.startLineNumber + 1;
      // Cursor first trims edits that reach past the diff's lines. Those are rare, so they are
      // left to Cursor's normal handling instead.
      if (firstLine < 1 || lastLine > diff.newTextLines.length) return;

      let linesAddedAbove = 0;
      for (const change of handler.changes) {
        const addedStart = change.addedRange.startLineNumber;
        const addedEnd = change.addedRange.endLineNumberExclusive;
        if (firstLine < addedEnd && lastLine >= addedStart) return; // The edit touches a hunk.
        if (addedEnd <= firstLine) {
          const removedCount = change.removedLinesOriginalRange.endLineNumberExclusive - change.removedLinesOriginalRange.startLineNumber;
          linesAddedAbove += (addedEnd - addedStart) - removedCount;
        }
      }
      const originalFirstLine = firstLine - linesAddedAbove;
      const originalLastLine = lastLine - linesAddedAbove;
      if (originalFirstLine < 1 || originalLastLine > diff.originalTextLines.length) return;
      diff.originalTextLines = handler.applyEditToLines(diff.originalTextLines, {
        startLineIndex: originalFirstLine,
        endLineIndexInclusive: originalLastLine,
        startColumn: edit.range.startColumn,
        endColumn: edit.range.endColumn,
        text: edit.text,
        eol,
      });
    };

    // Cursor makes a new handler when Ctrl+Z brings a diff back, so the change goes on the code
    // all handlers share, and only acts on this tool's diffs.
    let isEditHandlingChanged = false;
    const changeEditHandling = (handler) => {
      if (isEditHandlingChanged) return;
      const shared = Object.getPrototypeOf(handler);
      const processOverlapEdit = shared && shared.processOverlapEdit;
      if (typeof processOverlapEdit !== "function" || typeof shared.applyEditToLines !== "function") {
        console.error("[agent-diff] Cursor's diff code changed; edits outside hunks will show as hunks.");
        return;
      }
      isEditHandlingChanged = true;
      shared.processOverlapEdit = function (edit, eol, ...rest) {
        try {
          if (ourDiffs.has(this.inlineDiff.id)) addEditOutsideHunksToOriginal(this, edit, eol);
        } catch (error) {
          console.error("[agent-diff] could not handle an edit:", error);
        }
        return processOverlapEdit.call(this, edit, eol, ...rest);
      };
    };

    commandsRegistry.registerCommand("_agentDiff.show", async (accessor, uri, originalText) => {
      const inlineDiffs = accessor.get(services.inlineDiffs);
      const textFiles = accessor.get(services.textFiles);
      const textModels = accessor.get(services.textModels);
      listenForFinishedUndo(accessor);

      // The agent wrote to disk. Load that text into the editor before comparing, like Cursor does.
      await textFiles.files.resolve(uri, { reload: { async: false }, forceReadFromFile: true }).catch(() => {});
      const reference = await textModels.createModelReference(uri);
      try {
        const currentLines = reference.object.textEditorModel.getLinesContent();
        // Only build on a diff this tool made. Cursor can leave old agent diffs behind with no
        // hunks, and their original text may be out of date. (Adding our diff still replaces any
        // other diff on the file: Cursor allows one per file.)
        const liveDiff = inlineDiffs.diffInfos.find((diff) => ourDiffs.has(diff.diffId) && isSameFile(diff.uri, uri));
        const liveHandler = liveDiff ? inlineDiffs.getHandlerByDiffId(liveDiff.diffId) : undefined;
        // A diff already on screen keeps its original. Cursor updates that original as hunks are
        // kept, so kept hunks do not come back. Cursor's own agent does the same on a second edit.
        const originalLines = liveHandler
          ? liveHandler.inlineDiff.originalTextLines.slice()
          : originalText == null ? [] : splitLines(originalText);

        if (liveDiff) inlineDiffs.remove(liveDiff.diffId, { shouldStorePrevState: false });
        if (haveSameLines(originalLines, currentLines)) return { diffId: null, changed: false };

        const handler = await inlineDiffs.addDecorationsOnlyDiff({
          uri,
          generationUUID: makeId(),
          currentRange: { startLineNumber: 1, endLineNumberExclusive: currentLines.length + 1 },
          originalTextLines: originalLines,
          newTextLines: currentLines,
          prompt: "<agent-diff>",
          attachedToPromptBar: false,
          // Cursor's file bar and "next diff file" commands only list diffs with this source.
          source: "speculative-full-file",
          createdAt: Date.now(),
          hideDeletionViewZones: false,
          hideDecorations: false,
        }, undefined, false);
        if (!handler) return { diffId: null, changed: true };
        rememberOurDiff(handler.id);
        changeEditHandling(handler);
        return { diffId: handler.id, changed: true };
      } finally {
        reference.dispose();
      }
    });

    // Stop showing diffs without changing any text (like Keep, but silent).
    commandsRegistry.registerCommand("_agentDiff.clear", (accessor, uri) => {
      const inlineDiffs = accessor.get(services.inlineDiffs);
      let clearedCount = 0;
      for (const diff of inlineDiffs.diffInfos) {
        if (!ourDiffs.has(diff.diffId)) continue;
        if (uri && !isSameFile(diff.uri, uri)) continue;
        inlineDiffs.remove(diff.diffId, { shouldStorePrevState: false });
        clearedCount++;
      }
      return { cleared: clearedCount };
    });

    commandsRegistry.registerCommand("_agentDiff.list", (accessor) => {
      const inlineDiffs = accessor.get(services.inlineDiffs);
      return inlineDiffs.diffInfos.map((diff) => ({
        path: diff.uri.fsPath,
        diffId: diff.diffId,
        isOurs: ourDiffs.has(diff.diffId),
      }));
    });

    commandsRegistry.registerCommand("_agentDiff.version", () => patchVersion);
  } catch (error) {
    console.error("[agent-diff] patch did not load:", error);
  }
})();`;
