# Folders

Folders are real directories that Obelisk keeps; tags find things across folders; a
file's format decides how it opens. The tree on disk matches the tree in the app, and
Show in Finder always works, but Obelisk owns the layout. What's on disk is in
[library-format.md](library-format.md). The code is `packages/core/folders.js` and
`desktop/renderer/folders.js`; the tests are `tests/folders.test.js` and
`tests/safety.test.js`.

## Save to, and groups

Every importer shows a **Save to** folder, remembered by ID, so renaming or moving the
folder keeps it as the destination.

If that folder is deleted:
- **A new import** asks for a folder first.
- **A download already queued** goes to **Inbox**, and its row says why.

Nothing is guessed or recreated.

**Groups** are folders made for something that keeps arriving: a podcast show, or a
collection. The folder records the group in `source.key`, and later files go to the
folder with that key, wherever it has been moved or renamed. Only when no folder has
the key is a new one made, in the current destination.

**Collections** start in the default folder for their type, found by name (`Images`,
`Documents/Books`) and made if missing. Renamed folders aren't followed. Each
collection's own folder is then a group, as above. See [collections.md](collections.md).

**Imports from this computer** use one Save to for the whole review, and each file can
be changed. It starts as the folder you were in.

## Inbox

A normal folder that can be renamed but not deleted. It receives downloads whose
folder is gone, and item folders found at the root.

## Operations

| Action | On disk |
|---|---|
| Create | Make the directory and write `folder.json`. |
| Rename | Update `folder.json` and rename the directory; a change of case goes through a temporary name. |
| Move a folder or file | Rename into the new parent. |
| Reorder | Write each sibling's `position`. |
| Delete, keep contents | Move each child up a level, then send the empty folder to the Trash. |
| Delete with contents | Send the folder and everything in it to the system Trash. |

**Multi-step operations.** Anything with more than one rename writes its plan to
`.obelisk/journal.json` first:
- **A rename fails partway:** the ones already done are undone, so nothing ends up
  half-moved.
- **A crash, or an undo that also fails:** the plan is finished the next time the
  library opens.
- **Recovery can't finish a step,** or something else has taken its destination: the
  plan is kept, the catalog stays with the files, and it's tried again on the next
  opening. There's one plan at a time, so moves and renames are refused, saying
  what's in the way, until it finishes.
- **Every path** must stay inside the library, symlinks included: journal steps,
  moves, new folders, `folder.json` and imports. A folder replaced by a link to
  somewhere else is refused, not followed.

**Moving a single file.** A file that shares its folder with other things, or sits
apart from its manifest, moves on its own into a new item folder with its manifest.
Nothing else comes with it.

**Refused:**
- moving a folder into itself
- deleting Inbox
- deleting a folder a download is still saving into

## Duplicates

Imports never refuse identical files; the same bytes can live in several folders.
Downloads do check their source, so the same episode or map edition isn't fetched
twice.

## In the app

- **Sidebar:** folders and their subfolders, Inbox first. Each section (Shortcuts,
  Folders, Tags) folds away from its heading. Clicking a folder opens it and reveals
  its subfolders; its arrow can collapse the branch.
- **Dragging:**
  - **onto a folder** puts it inside
  - **onto the line between folders** puts it beside them, in that place
  - **just below an open folder** puts it first inside that folder
- **Main view:** subfolders as tiles, then the files at this level. **Show
  subfolders** shows everything below. Its switch keeps the thumb centered in either position.
- **Empty folders** say how to fill them. **Backups**, found by name, says what
  belongs there.
- **Format filters** like "All audio" work across the whole library. They're a filter,
  not a second tree.
