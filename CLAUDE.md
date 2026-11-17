# Notes for Claude

## Social handles in GitHub text

Always wrap Instagram, X, Facebook and other social handles in backticks
(`` `@citizengo` ``, never a bare @citizengo) in PR titles and descriptions,
commit messages, issues and comments.

GitHub reads a bare `@name` as a mention of the GitHub user with that name,
emails them and subscribes them to the thread. Many of our handles match real
GitHub accounts: a bare @citizengo in PR #189 notified the "CitizenGO" GitHub
account, whose email goes to the recruiting inbox.

Only use a bare `@` for a real GitHub login you actually mean to notify.
