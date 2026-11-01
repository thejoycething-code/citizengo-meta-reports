# Tracked links in replies and private messages

Since 1 Nov 2026, the Content Engine replaces every CitizenGO petition link in a reply or private message with a tracked link at the moment it is queued. This covers replies typed on the desk and automations, on Facebook and Instagram. `utm_campaign` says where the link was sent and who sent it.

## utm_campaign structure

It keeps the CitizenGO UTM standard, `LIST-DATE-TITLE-OWNER-CTA_TYPE-SCOPE-TOPIC-ASSETID-SERIES`. Campaign Copilot keeps only the first 40 characters of TITLE, so the marker goes at the front of TITLE:

```
EN_GB-2026_11_01-DM_TBS_She_Was_Abducted_At_12_UK_Aid_To-CJO-AA_NA-LO-FR-19439-FB1
                 ^^ ^^^                                    ^^^                   ^^^
                 |  sender's initials                     Copilot owner         where it was sent (FB1 / IG1)
                 marker
```

| Marker | Meaning |
|---|---|
| `DM`  | private message typed on the desk (includes Messenger and Instagram DM replies) |
| `RE`  | public reply typed on the desk |
| `ADM` | private message sent by an automation (comment-to-DM, including the built-in "SIGN") |
| `ARE` | public reply sent by an automation |
| no marker | the post's own link (made by the morning link run) |
| `FC`, `BIO`, `ST` | kept for the first comment, link in bio and Stories |

- **Sender's initials:** 2–3 letters, set per person in Settings › Team and access. They should match the person's own Copilot initials. An automation uses its maker's initials. Someone with no initials yet gets the post's own owner.
- **OWNER:** whoever the engine's Copilot sign-in belongs to (Copilot sets it).
- **utm_source:** `fb` or `ig`. **utm_medium:** `social`. **utm_content:** `link_1` (Copilot's default).

Looker lowercases `utm_campaign`. To split replies and DMs from post links:

```
REGEXP_EXTRACT(utm_campaign, '^[^-]+-[^-]+-(dm|re|adm|are)_')        -- marker
REGEXP_EXTRACT(utm_campaign, '^[^-]+-[^-]+-(?:dm|re|adm|are)_([a-z]{2,3})_')  -- sender
```

## When Copilot can't be reached

The link goes out as the long `citizengo.org/<locale>/<cat>/<id>?campaign=…&utm_source=…&utm_medium=social&utm_campaign=…&utm_content=link_1` with the same code Copilot would have made. Signatures are attributed the same way; the link is just not shortened. Every link made is recorded in `engine_tracked_links` (`via` = `copilot` or `long`).

## The engine's Copilot sign-in

Sign in once from the laptop (it opens the browser):

```
SUPABASE_URL=https://hxymihnuzbxianbpdovo.supabase.co SUPABASE_SERVICE_KEY="$(pbpaste)" npm run -s copilot:login
```

The sign-in is saved in `engine_copilot_auth`, which only the service key can read. Vercel and the Mini both use it. It is a separate Copilot client from the laptop's `copilot_mcp.py`, so their refreshes don't clash.
