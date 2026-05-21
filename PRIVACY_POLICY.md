# Privacy Policy

*Applies to the Muse unofficial fork maintained by NanashiTheNameless ([github.com/NanashiTheNameless/muse](https://github.com/NanashiTheNameless/muse)). This is not the upstream Muse project.*

*Last updated: May 20, 2026*

## 1. Who Collects Your Data

Muse is self-hosted software. The **operator** of each instance - the person or organization who deployed it - controls all data stored by that instance. This policy describes what data Muse stores by design. Contact your instance's operator with any privacy concerns.

## 2. Data Collected

### 2.1 Per-Server Settings

Muse stores the following per-guild configuration in a SQLite database:

| Field | Description |
| --- | --- |
| Guild ID | Discord server identifier |
| Playlist limit | Maximum tracks importable from a playlist |
| Queue/leave behavior | Idle timeout and listener-count settings |
| Default volume | Playback volume for the server |
| Default queue page size | Pagination setting |
| Auto-announce next song | UI behavior toggles |

No message content, user nicknames, or voice data are stored.

### 2.2 Favorite Queries

When a user saves a favorite, Muse stores:

| Field | Description |
| --- | --- |
| Guild ID | Server where the favorite was created |
| Author ID | Discord user ID of the creator |
| Name | Label given to the favorite |
| Query | The search term or URL saved |

### 2.3 Caches

Muse maintains two caches:

- **File cache** - Hashed audio files temporarily stored on disk to reduce re-downloads. No user identifiers are included.
- **Key-value cache** - Short-lived metadata responses (e.g. YouTube API results). Entries expire automatically and contain no personal information.

## 3. Data Not Collected

Muse does **not** collect or store:

- Message content outside of command interactions.
- Voice audio.
- Email addresses, IP addresses, or payment information.
- Data from users who have not issued a command.

## 4. Third-Party Services

Resolving and playing tracks requires outbound requests to:

- **YouTube Data API v3** - to look up video and playlist metadata.
- **YouTube** - to stream audio. Cookies may optionally be provided by the operator to authenticate these requests.

Your use of these services is governed by [Google's Privacy Policy](https://policies.google.com/privacy).

## 5. Data Retention and Deletion

**Favorites** are retained until explicitly deleted. Any user can remove their own favorites with `/favorites remove`. Users with the **Manage Server** Discord permission can remove any favorite in the server.

**Guild settings** have no in-bot deletion command. To remove a server's settings record entirely, the operator must delete the row directly from the SQLite database (`DELETE FROM Setting WHERE guildId = '...'`). Removing the bot from a server does not automatically delete its settings.

**File cache** entries are evicted automatically by the bot based on size and last-access time. The operator can also clear the `data/cache/` directory manually while the bot is stopped.

**Key-value cache** entries expire automatically and are not retained beyond their TTL.

## 6. Data Sharing

Muse does not transmit stored data to any third party beyond the YouTube/Google requests described above. The operator may access the local database directly as part of administering the host system.

## 7. Your Rights

Depending on your jurisdiction, you may have rights to access, correct, or delete data associated with your Discord user ID.

- **Favorites you created**: use `/favorites remove` directly in Discord.
- **Guild settings or data you cannot remove yourself**: contact the operator of the specific Muse instance you are using. The operator can delete records directly from the database on request.

## 8. Children

Muse is not directed at children under 13. Users must comply with Discord's minimum age requirements.

## 9. License

The Muse software underlying this service is distributed under the [MIT License](LICENSE). This policy covers data practices only and does not affect the rights granted by that license.

## 10. Changes

The operator may update this policy at any time. Material changes will be communicated through the server where the bot is deployed.
