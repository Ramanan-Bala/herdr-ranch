## Feature TODOs

- [x] Once the agent exits, tasks in the session details should cleared, since there is no active session anymore. This will help in maintaining a clean state for the next session.
- [x] When agent stops, all the inprogress tasks should be in paused state, so that when the agent is restarted, it can resume from where it left off. This will help in maintaining continuity and avoid loss of progress.
- [x] Opencode, Claude and most harness allow user to change the sessions in the same window, even opencode allow user to open multiple session as tabs in the same window , when this happens, the previous session's details should be cleared to avoid confusion and ensure that the new session starts with a fresh state/ existing state.
- [x] Tasks list grows as session kept for longer time, so there should be a limit on the number of tasks that can be stored in the session details. This will help in preventing memory issues and ensure that the system remains responsive.
- [x] Recent commits should also show the main branch's last commit, it's that the last 5 commits of any branch no rule there.
- [x] Side spaces and session should be reordered, drag and dropable, so that user can arrange them in the order they want. This will help in improving the user experience and make it easier to access frequently used sessions.
- [x] There is no need for the shortcut buttons that's at the top of the session details.
- [x] % completed that shows in the session details, next to activity is not proper. the tasks progress bar also not fully completed on all the tasks completed. (BUG)
- [x] When the agent is stopped but it's subagent is running still it should be considered as running in the sidebar, since the subagent is still running and performing tasks. This will help in providing accurate information to the user and avoid confusion.

## UI Improvements

- [x] Sidebar with project and workspace should be easy to read and navigate, with clear labels and icons. This will help users quickly find the information they need and improve overall usability.
- [x] Current sidebar is not very user friendly, it should be more intuitive and easy to use. This will help users quickly access the features they need and improve overall user experience.
- [x] Collapsible sidebar should be implemented, so that users can hide or show the sidebar as needed. This will help in maximizing the available screen space and improve overall usability.
- [x] When the workspace is hovered on the sidebar, it should show the workspace details and all it's opened session and it's details in popover. This will help users quickly access important information without having to navigate away from their current view. (when collapsed)
- [x] Add proper borders and spacings, when something is expandable by draging the border make it obvious when hover, like sidebar can be expanded by dragging the border, so when user hovers on the border, it should show a visual cue that it can be dragged to expand or collapse. This will help users understand how to interact with the interface and improve overall usability.
- [x] Top bar should have full border from the left edge where logo starts to the right edge and same goes to the bottom status bar.
- [x] Agent's usage should be hidable in the ranch settings, ranch settings section should be looked into for better UI and UX and it should be more apealing and easy to use. This will help users customize their experience and improve overall usability.
