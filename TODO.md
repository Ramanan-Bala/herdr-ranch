1. Once the agent exits, tasks in the session details should cleared, since there is no active session anymore. This will help in maintaining a clean state for the next session.
2. When agent stops, all the inprogress tasks should be in paused state, so that when the agent is restarted, it can resume from where it left off. This will help in maintaining continuity and avoid loss of progress.
3. Opencode, Claude and most harness allow user to change the sessions in the same window, even opencode allow user to open multiple session as tabs in the same window , when this happens, the previous session's details should be cleared to avoid confusion and ensure that the new session starts with a fresh state/ existing state.
4. Tasks list grows as session kept for longer time, so there should be a limit on the number of tasks that can be stored in the session details. This will help in preventing memory issues and ensure that the system remains responsive.
5. Recent commits should also show the main branch's last commit, it's that the last 5 commits of any branch no rule there.
6. Side spaces and session should be reordered, drag and dropable, so that user can arrange them in the order they want. This will help in improving the user experience and make it easier to access frequently used sessions.
7. There is no need for the shortcut buttons that's at the top of the session details.
8. % completed that shows in the session details, next to activity is not proper. the tasks progress bar also not fully completed on all the tasks completed. (BUG)
