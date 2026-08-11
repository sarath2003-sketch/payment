# PF Chit Fund Club — Architecture Report + Implementation Plan

## STEP 1: Architecture Inspection Results

### Confirmed Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML/CSS/JS (Single File SPA — `public/index.html` & `public/admin.html`) |
| **Backend** | Node.js + Express.js (`index.js` + `server/routes/`) |
| **Database** | **SQLite** (primary active DB — PostgreSQL offline/unavailable, fallback is `server/database/payment_system.sqlite`) |
| **Authentication** | JWT tokens, middleware in `server/middleware/auth.js`. Token stored in `authToken` var, sent as `Authorization: Bearer` |
| **Real-time** | **Socket.IO v4** (`socket.io` package) — fully wired, server running on same port |
| **File Uploads** | `express-fileupload` + `multer` — uploads stored to `./uploads/` |

---

### Existing Live Chat Implementation

- **Table**: `chat_groups` (status: `PENDING/ACTIVE/FULL/INACTIVE`)
- **Table**: `chat_group_members` (role, is_speaker, is_muted, is_online)
- **Table**: `chat_group_messages` (text + image)
- **Table**: `chat_group_requests` (member requests new room → admin approves)
- **Admin API**: `POST /api/admin/chat-groups/create` → creates group with status `ACTIVE`
- **Admin API**: `POST /api/admin/chat-groups/requests/:id/approve` → creates group with status `ACTIVE`
- **Member API**: `GET /api/chat-groups` → filters `WHERE g.status IN ('APPROVED', 'ACTIVE', 'FULL')`
- **Frontend**: `loadChatGroups()` function in `public/index.html` line 2739
- **Socket.IO rooms**: `group_${groupId}` — events: `group:new-message`, `group:member-joined`, `group:member-left`

**🔴 ROOT CAUSE BUG IDENTIFIED:**
The admin creates a room directly as `ACTIVE` (not `APPROVED`). The member-side query filters `IN ('APPROVED', 'ACTIVE', 'FULL')` — **`ACTIVE` IS INCLUDED**, so the query is correct. However:
1. The `admin-chat-groups.js` `/create` route inserts to `chat_group_members` with a column `is_owner` that **does NOT exist** in the `chat_group_members` table schema — causing a **SQL INSERT ERROR** that silently rolls back.
2. When creation fails, no group is saved at all, so the member list returns empty.
3. The member `loadChatGroups()` catches the API error but silently shows empty — leading to the "missing data / infinite loading" illusion.

Additionally: the member frontend shows a loading spinner initially (line 1260) but only replaces it when `loadChatGroups()` is called, which happens ONLY when the user navigates to `chat-rooms` tab.

---

### Existing Live Activity Implementation

- **Tables**: `auctions`, `bids`, `auction_chat_messages`, `muted_members`
- **Routes**: `server/routes/auction.js` — mounted at both `/api/auction` AND `/api/live-activities`
- **Timer**: Server-side `auctionTimerManager` in `index.js` — uses `setInterval` per auction, broadcasts `auction:timer-tick` via Socket.IO
- **Status states**: `SCHEDULED → WAITING → LIVE → PAUSED → ENDED / CANCELLED`
- **Amount/bid logic**: Existing `/api/auction/:id/bid` and `/api/auction/:id/amount` endpoints — both have concurrency protection via `FOR UPDATE` + optimistic locking, ₹100 increment check, and 409 conflict response
- **Winner**: `endAuction()` function determines winner, stores `winner_id`, `final_amount`, `ended_at`, creates transaction ledger entry

**Current database**: 5 `ENDED` auctions in SQLite, no active chat groups.

---

### Other Routes

| Route | File |
|---|---|
| Member auth + profile | `server/routes/member-auth.js` |
| Payment proofs | `server/routes/payment-verification.js` |
| Notifications | `server/routes/notifications.js` |
| Monthly payments | `server/routes/monthly-payments.js` |
| Settings | `server/routes/settings.js` |
| Admin members | `server/routes/admin-members.js` |

---

## Bug Root Causes (Priority 1 — Chat Room Visibility)

### Bug 1: `is_owner` column doesn't exist in `chat_group_members`

In `admin-chat-groups.js` line 76:
```sql
INSERT INTO chat_group_members (group_id, member_id, is_speaker, is_owner, is_muted)
```
The schema has NO `is_owner` column. This causes the INSERT to **fail silently** (caught by `ROLLBACK`), meaning the group is created in `chat_groups` but the room creator is never added as a member — and the commit succeeds for `chat_groups` but not for members.

**Fix**: Remove `is_owner` from the INSERT, use `role = 'ADMIN'` instead.

### Bug 2: Member frontend shows infinite loading spinner

`chatGroupsGrid` starts with a `.loading-state` spinner (line 1260). If `loadChatGroups()` fails (API error), it replaces with error message. But if the API returns `{ groups: [] }`, it shows "No Active Chat Rooms" which is correct. The real issue is **Bug 1** preventing rooms from ever being created.

### Bug 3: `join` route checks `status !== 'ACTIVE' && !== 'FULL'` — won't allow joining `APPROVED` rooms

The `/api/chat-groups/:id/join` handler (line 217 in `chat-groups.js`) only allows join when `status === 'ACTIVE' || 'FULL'`. If a room is ever in `APPROVED` state (not yet `ACTIVE`), members cannot join. We need consistent status handling.

---

## Proposed Changes

### Priority 1 — Fix Live Chat Room Approval Visibility

---

#### [MODIFY] [admin-chat-groups.js](file:///c:/Users/acer/OneDrive/Documents/payment/server/routes/admin-chat-groups.js)

**Line 76**: Remove `is_owner` from the INSERT — column does not exist.
Change to use `role = 'ADMIN'` pattern that already exists in the approve flow.

#### [MODIFY] [public/index.html](file:///c:/Users/acer/OneDrive/Documents/payment/public/index.html)

- `loadChatGroups()`: Add proper LOADING, SUCCESS, EMPTY, ERROR, RETRY states
- Add timeout protection so loading spinner never stays forever
- Show user-friendly error message with Retry button on API failure

---

### Priority 2 — Live Activity / Timer Engine

The existing `auctions` table + `auction.js` already implements everything needed. What's missing:

- **Frontend Live Activity page**: The member portal shows auction info in `auctionPage` but it's basic — needs to display: LIVE badge, starting amount, current amount, timer, latest bidder, activity feed
- **Admin can already create auctions** — needs UI improvement with 120/180s presets  
- **The `bid_increment` is currently `500` by default** (app_settings: `auction_default_bid_increment = 500`) — needs to change to `100` as specified

#### [MODIFY] Backend — `server/database/schema.sql` + `server/config/database.js`
- Update default `bid_increment` in app_settings from `500` to `100`

#### [MODIFY] Frontend — `public/index.html` auction page
- Redesign to show: LIVE badge, Starting Amount, Current Amount, Increment, Timer countdown, Latest Bidder with photo, Activity Feed
- Timer must read `remaining_seconds` from server on load, then count down locally via `setInterval`, sync on Socket.IO `auction:timer-tick`

---

### Priority 3 — Member Profile + Photo

The `members` table already has `profile_photo VARCHAR(500)`.

#### [NEW] `POST /api/member-auth/upload-photo`
Add photo upload endpoint to `member-auth.js`.

#### [MODIFY] `public/index.html`
- Add profile photo display in settings page
- Add upload/change/remove photo buttons

---

### Priority 4 — Notifications

Already fully implemented:
- Backend: `server/routes/notifications.js` — GET, mark-read, unread-count
- DB: `notifications` table exists with all needed fields
- Socket.IO: `notification:broadcast` event already emitted on auction events

**Missing**: Frontend notification bell, unread badge, dropdown panel in `public/index.html`.

---

### Priority 5 — Monthly History / Payment Flow

- Already have: `payment_proofs` table, `monthly_payments`, `payment-verification.js`
- Missing: Member profile page showing monthly summary — to be added to settings page

---

## Implementation Order

1. **Fix Bug 1** (admin-chat-groups.js — remove `is_owner`)
2. **Fix Bug 2** (Frontend loadChatGroups — proper states + retry)
3. **Improve Live Activity UI** in member portal
4. **Add profile photo upload**
5. **Add notification bell + panel** to frontend
6. **Monthly history tab** in member profile
7. **Polish & performance**

---

## Open Questions / Notes

> [!IMPORTANT]
> The active database is SQLite (PostgreSQL is offline). All schema changes must also be reflected in `server/config/database.js` SQLite initialization block.

> [!WARNING]  
> The `member-ui.html` at the workspace root appears to be a backup/copy. The **live served file** is `public/index.html`. All frontend changes must go to `public/index.html`.

> [!NOTE]
> Default `bid_increment` in app_settings is currently `500` (not `100` as the spec requires). The spec says `incrementAmount = 100`. Will change the SQLite default and admin UI.
