# Teams bot and Exchange managed-identity capabilities

This is a practical action catalog, not a promise that every Teams or Outlook
screen has an automation equivalent. Capabilities depend on the API, application
permissions, resource scope, installation, tenant policy and licensing.
Reviewed against Microsoft documentation on 2026-10-23.

**Managed identity supplies credentials; it does not supply permissions.**
Bot Connector, Microsoft Graph and Exchange Online PowerShell are different
interfaces. A bot registration does not automatically authorize all three.
Nothing in this list enables extra permissions, restores message deletion or
changes mailbox settings.

## What this project currently implements

| Workload | Implemented journeys | Authorization and boundaries |
| --- | --- | --- |
| Teams messaging | Publish/read back a channel message; publish a parent, reply and read back the reply | Verified live with retained bot-authored posts/replies and Healthy journey reports. The bot is installed in the team; a separate Entra readback application has only team-scoped `ChannelMessage.Read.Group` and uses managed-identity federation. Calls and Bot Connector keep the original bot identity; no runtime user MFA, secret or user-token cache is needed. |
| Teams calling | Individually place calls to configured test accounts, wait briefly, then end and verify termination | `Calls.Initiate.All` has been approved. This does **not** prove that each recipient client rang, answered or carried usable media. The root config contains the permitted targets: a code/configuration allowlist, not an Entra-enforced per-user scope. See [deployment status](./deployment.md) for actual live results. |
| Exchange | Send mail to the test mailbox and verify delivery; create, edit and reopen a draft | Exchange RBAC for Applications grants `Application Mail.ReadWrite` and `Application Mail.Send` to one approved mailbox. Other mailboxes are not implicitly authorized. |

The active trial retains mail, sent copies, drafts and Teams messages for
inspection. Call termination is mandatory resource cleanup and is **not**
disabled by the message-retention settings.

## Teams: messaging and interaction

These are bot/application capabilities, not permission to impersonate an
employee.

| Action family | Possible actions | Requirements / limitations |
| --- | --- | --- |
| Channel messages | Start a conversation, send text/formatted content, mention supported participants, reply in a thread | Bot installed in the relevant team and valid conversation/channel context. Channel type and tenant policy can affect support. |
| Personal messages | Send a bot message directly to a user; continue an existing personal conversation | Personal-scope installation and conversation access. The current lab package does not enable personal-scope messaging. |
| Group-chat messages | Participate in an authorized group conversation, send messages and replies | Bot must be installed in that chat; installation in a team does not authorize an unrelated chat. |
| Proactive notifications | Send scheduled reminders, monitoring alerts and workflow updates without a new user message | Bot must have access to that conversation. Preserve or obtain valid conversation routing; no arbitrary-user messaging just from knowing an email address. |
| Update bot messages | Replace or refresh content previously sent by the bot, including status cards | Save the activity ID and conversation context. This is not general permission to edit human-authored messages. |
| Delete bot messages | Remove the bot's own activity | Connector deletion and Graph message-deletion APIs have different permissions and restrictions. Trial deletion is currently disabled. |
| Cards | Send Adaptive Cards, collect supported form inputs and handle card actions | Card schema/client support and an implemented authenticated interaction handler. Rendering a card does not execute the business operation behind it. |
| Dialogs | Open supported dialogs, display forms and process submissions | Additional Teams invoke handlers and manifest setup; usually initiated by user interaction. |
| Message extensions | Search an external system, insert result cards, launch actions from compose/message context | Separate manifest commands, handlers and any permissions needed for the external system. |
| Installation/lifecycle events | Handle installation, removal and supported membership/conversation changes | Incoming activity endpoint, authentication and event handlers. Not supplied by the calling callback alone. |
| Member/context lookup | Read accessible conversation members and supported team/channel context | Connector context APIs or separately authorized Graph membership APIs. Access is not unrestricted directory enumeration. |
| Activity-feed notifications | Send supported notifications in the Teams activity feed | Activity definitions plus appropriate Graph/RSC authorization and installation. Separate from posting a chat message. |
| Presence | Read permitted user presence and use supported presence-session APIs | Separate Graph presence permissions and endpoint rules. Presence is not proof a person saw or answered a notification. |
| User SSO | Obtain a user-context token through a supported consented Teams SSO flow | Delegated-user capability; can require user interaction/MFA. It is not part of the unattended bot default. |

Sources: [conversation operations][teams-conversations],
[proactive messaging][teams-proactive], [cards and dialogs][teams-cards],
[message extensions][teams-extensions], [Teams SSO][teams-sso],
[resource-specific consent][teams-rsc].

## Teams: calls and meetings

| Action family | Possible actions | Requirements / limitations |
| --- | --- | --- |
| Direct user calls | Initiate a one-to-one call to a Teams-enabled account; inspect signaling state; end the call | Calling-bot registration, HTTPS notifications and `Calls.Initiate.All`. Outbound signaling does not guarantee observable remote ringing. Neither create acceptance nor an `establishing` state proves that the recipient client rang. |
| Group calls | Initiate a supported group call and invite participants | Appropriate group-calling application permission; not covered just by assuming the direct-call grant is sufficient. |
| Incoming calls | Receive notifications and implement answering, rejecting, redirecting or other supported call control | Authenticated callback and the appropriate API/permissions. These handlers must be implemented explicitly. |
| Call lifecycle | Observe state, list supported participant information and terminate the bot's call leg | API ownership/permissions and bounded failure cleanup. Ending the bot's leg in a meeting does not end the meeting for everyone. |
| Scheduled-meeting participation | Join an existing dedicated meeting, inspect connection state and leave | Appropriate calling permission or supported meeting-chat RSC consent, exact meeting metadata and compatible lobby/organizer policies. Not a substitute for calling each test account. |
| Service-hosted media operations | Use supported platform-hosted prompts, tones and related call operations | Microsoft hosts the media. Each operation has its own API constraints; this does not provide arbitrary microphone/speaker validation. |
| Custom audio/video processing | Receive/process media streams, implement specialized audio/video applications | Additional `Calls.AccessMedia.All` and Microsoft's supported application-hosted media stack/hosting requirements. The current Linux Container Apps worker is not an application-hosted media implementation. |
| Meeting creation/updates | Create or modify an online-meeting resource for an approved organizer | Separate `OnlineMeetings.*` authorization; app-only organizer access can require a Teams application access policy. Not needed for the current direct-call placement check. |
| Calendar invitations | Create/update an Outlook calendar event with Teams meeting information, invite attendees and track responses | Exchange/Graph calendar permissions; distinct from merely creating an `onlineMeeting` object. |
| Attendance/artifacts | Retrieve supported attendance reports, transcripts and recordings | Separate artifact-specific permissions, applicable policies, meeting eligibility and licensing. The artifact must actually exist; reading it does not create it. |
| Meeting apps/interactions | Implement meeting-side panels, cards and supported participant interactions | Additional Teams app capabilities/handlers, installation and applicable meeting-scoped permissions. |

**Important limits**

- Ringing is Graph signaling evidence, not continuous proof of a client-side
  toast, audible ringtone, employee sign-in, answer or audio/video quality.
- A bot cannot silently answer a call *as the test user*. App-only operation
  does not turn it into that person's Teams session.
- `Calls.Initiate.All` is tenant-wide. The documented online-meeting
  application access policy must **not** be presented as a proven way to
  scope which recipients this calling permission can ring.
- The Graph calling API documents calling registration and application
  permissions separately from Bot Connector's proactive-message installation
  requirement. Do not assume those two capabilities have identical prerequisites.
- Recording/transcription, consent and compliance requirements remain in force.
  Call signaling permission is not blanket authorization to record employees.

Sources: [create calls][graph-calls], [call operations][graph-call-resource],
[application-hosted media requirements][teams-media],
[online-meeting access policies][meeting-policy],
[meeting transcripts][meeting-transcripts].

## Teams: administration and connected workloads

| Action family | Possible actions | Requirements / limitations |
| --- | --- | --- |
| Message observation | Read permitted channel/chat messages and supported changes | Graph permissions or resource-specific consent. Bot Connector is not a general message-history reader. |
| Graph message submission | Use supported resource-scoped application messaging APIs | Verify the exact endpoint's supported permissions. Do **not** use migration-only permissions as a shortcut for normal synthetic posting. |
| Team lifecycle | Create, configure, archive/unarchive or delete a team | Additional Graph administration permissions. Deleting the underlying group has wider effects than deleting a bot message. |
| Channels | List/create/configure/archive/delete supported channel types | Channel-specific Graph authorization and channel-type restrictions. |
| Membership | Read/add/remove supported team/channel members and owners | Additional membership permissions and role/type restrictions. |
| Chats | Create/manage supported chats and their membership | Separate Graph chat permissions; application support varies by operation. Not unrestricted access to every employee conversation. |
| Apps | Install, upgrade, inspect or remove apps in supported user/team/chat contexts | Provisioning/installation permissions. These are not granted to the monitoring worker just to run a probe. |
| Tabs | Read/create/configure/remove supported tabs | Graph tab permissions or suitable RSC permission and installation. |
| Moderation/compliance | Use specifically supported policy/compliance APIs | Separate privileged capabilities. Ordinary bot messaging does not allow editing/deleting arbitrary human-authored content. |
| Channel files | Upload, download, edit, rename, move and delete authorized files | Primarily **SharePoint/OneDrive** APIs and permissions, not Bot Connector. Prefer appropriately scoped site/file authorization. |
| Planner/tasks | Work with tasks/plans exposed through Teams | Separate Planner/task APIs and their supported application/delegated permissions. A Teams tab does not grant access to the underlying workload. |

Sources: [Teams Graph overview][teams-graph], [resource-specific consent][teams-rsc].
These administration and connected-workload actions are not implemented merely
because a bot is installed.

## Exchange: mailbox actions with managed identity

The first group is generally within the current mailbox-scoped mail permissions,
but **only the two documented journeys are implemented and live-tested here**.
Additional operations still need implementation, endpoint validation and policy
review.

| Action family | Possible actions | Current authorization / additional requirements |
| --- | --- | --- |
| Read mail | List/open messages, inspect headers, bodies, recipients and supported properties | Current `Application Mail.ReadWrite`, restricted to the approved mailbox. |
| Find/synchronize mail | Filter/search supported message collections; page results; track supported delta changes | Mail-read authorization and endpoint limits. Not the same as tenant-wide search, eDiscovery or every Outlook search feature. |
| Folders | Read/create/rename supported mail folders; organize messages into folders | Current mail read/write scope; special/system folders have restrictions. |
| Drafts | Create a draft, edit it, reopen it and delete it | Current mail read/write scope. Create/edit/reopen is implemented; deletion is intentionally disabled in the active trial. |
| Attachments | Read/add/remove supported attachments; use upload sessions where supported | Mail read/write scope, item state and API size/type restrictions. |
| Message organization | Mark read/unread; update flags and categories; move/copy messages | Current mail read/write scope. Managing the mailbox's master-category definitions can require mailbox-settings permissions instead. |
| Delete mail | Move supported messages to Deleted Items; use stronger deletion operations only where supported/approved | Mail read/write scope does not override retention, holds or recovery policy. Currently disabled for inspection. |
| Send mail | Send from the authorized mailbox, including supported formatted/MIME messages and attachments | Current `Application Mail.Send`. Sender scope, transport limits, anti-spam and delivery policies still apply. |
| Reply/forward | Send a reply/reply-all/forward; create and edit a draft response | Sending requires mail-send authorization; draft operations require mail read/write. The lab has both, within its mailbox scope. |
| Verify delivery | Correlate Sent Items and received messages and inspect delivery evidence | Current sender/receiver mailbox access. Send acceptance alone does not prove delivery or that a person opened the mail. |
| Other/shared mailboxes | Perform authorized mail operations in an additional approved mailbox | Expand the Exchange application resource scope explicitly. Existing access to one mailbox is not access to all shared mailboxes. |
| Change notifications | Subscribe to supported mailbox changes and process lifecycle/renewal notifications | Endpoint-supported application permissions plus authenticated notification/lifecycle infrastructure. Not currently implemented or verified by the mail probe. |
| Inbox rules | Read/create/update/delete supported inbox rules | Separate mailbox-settings authorization, commonly `MailboxSettings.ReadWrite`; not granted by the current mail-only roles. |
| Automatic replies | Read/configure supported out-of-office settings | Separate mailbox-settings authorization. |
| Mailbox preferences | Read/change supported language, time-zone and working-hours settings | Separate mailbox-settings authorization and per-operation support. |
| Master categories | Read/create/update/delete supported category definitions | Separate mailbox-settings authorization; assigning a category to a message is a different operation. |
| Calendars/events | Read/create/update/delete calendars and events; manage supported recurrence | Separate calendar application permission/RBAC role and mailbox scope. |
| Meeting invitations | Invite attendees, update/cancel meetings, and submit supported responses | Calendar authorization, organizer/attendee semantics and tenant policies. |
| Availability | Query supported free/busy/scheduling information | Appropriate calendar permission and scope; no implication that someone is currently using Teams. |
| Calendar sharing | Inspect/manage supported calendar permissions and sharing | Endpoint-specific calendar authorization and organization sharing policy. |
| Contacts | Read/create/update/delete supported contacts and contact folders | Separate contacts permission/RBAC role. Not authorization for the whole Entra directory. |
| Calendar/mailbox delegation | Grant another principal mailbox/calendar access, Send As or Send on Behalf | Appropriate supported sharing API or Exchange administrative RBAC. Not automatically included in mail read/write. |
| Sensitivity/protected content | Use supported label/protection operations and read content where authorized | Operation-specific information-protection support, permissions and licensing. Do not assume ordinary mail write access can relabel or decrypt every item. |

Application mail send can send as the mailbox that the application is authorized
to use. This is different from a signed-in user's delegated Send As/Send on
Behalf workflow; do not add a blanket claim that app-only send always needs a
human delegate grant. Arbitrary other From addresses are not authorized by the
current one-mailbox scope.

Sources: [Exchange RBAC for Applications][exchange-rbac],
[Graph mail overview][graph-mail], [mailbox settings][mail-settings],
[Graph calendar overview][graph-calendar].

## Exchange: administrative automation with managed identity

This is a **separate authorization surface** from the Graph mail journeys.
Where supported, Exchange Online PowerShell can authenticate using managed
identity, with the Exchange application permission and administrative RBAC
needed for the specific commands and hosting environment.

| Administration family | Examples | Boundary |
| --- | --- | --- |
| Mailbox/recipient administration | Inspect/configure supported mailboxes, aliases, recipient properties and conversions | Supported cmdlets, appropriate Exchange administrative roles and scope; not the current mail-data roles. User creation/licensing can also involve Entra. |
| Mailbox permissions | Inspect/grant/revoke supported mailbox and recipient permissions | Privileged Exchange RBAC; separate from reading/sending mail. |
| Mail flow | Inspect/create/change supported transport rules, connectors and delivery settings | Specific administrative roles and policy approval. Monitoring access does not imply permission to reconfigure routing. |
| Delivery diagnostics | Run supported message-trace and configuration diagnostics | Relevant read/diagnostic roles, service limits and retention. Does not guarantee recipient UI rendering. |
| Organization/mailbox policies | Manage supported sharing, forwarding, junk-mail, retention-related and other Exchange settings | Exact cmdlet, role, scope and license requirements. Purview/eDiscovery/compliance are separate surfaces, not blanket Exchange MI capabilities. |
| Reports/inventory | Collect supported recipient, mailbox and configuration statistics | Suitable read roles and supported unattended commands. |

Not every interactive Exchange PowerShell cmdlet supports application-only or
managed-identity execution. `Exchange.ManageAsApp` and appropriate administrative
RBAC are not supplied by the current `Application Mail.ReadWrite` /
`Application Mail.Send` assignments.

Do not build new Exchange Online monitoring on EWS. Microsoft documents a
phased EWS retirement beginning October 2026 and ending April 2027; check the
current tenant rollout and migration guidance rather than treating it as a
durable alternative to Graph.

Sources: [Exchange PowerShell managed identity][exchange-powershell],
[Exchange RBAC for Applications][exchange-rbac], [EWS migration][ews-migration].

## Useful next synthetic journeys

These are candidates, not enabled operations:

- **Teams:** bot/card round trip; channel post/update/readback; activity-feed
  notification; recipient-side ringing observation with an additional client
  observer; meeting join/connected/leave as a separate journey.
- **Exchange with current mail roles:** send/reply/readback, attachment
  round trip, move/reopen, category/flag readback, folder create/use/delete.
- **Exchange with additional grants:** meeting invitation/response,
  free/busy validation, contact update/readback, inbox-rule behavior or
  automatic-reply behavior in dedicated test mailboxes.

Prefer completed user-relevant outcomes over isolated API acceptance. Keep
changes reversible, use dedicated resources, and verify that notifications
reach the intended recipient where the journey claims to test notification
delivery.

[teams-conversations]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
[teams-proactive]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
[teams-cards]: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference
[teams-extensions]: https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/what-are-messaging-extensions
[teams-sso]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/auth-aad-sso-bots
[teams-rsc]: https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent
[teams-graph]: https://learn.microsoft.com/en-us/graph/teams-concept-overview
[graph-calls]: https://learn.microsoft.com/en-us/graph/api/application-post-calls
[graph-call-resource]: https://learn.microsoft.com/en-us/graph/api/resources/call
[teams-media]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots
[meeting-policy]: https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy
[meeting-transcripts]: https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts
[exchange-rbac]: https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac/
[graph-mail]: https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview
[mail-settings]: https://learn.microsoft.com/en-us/graph/api/resources/mailboxsettings
[graph-calendar]: https://learn.microsoft.com/en-us/graph/outlook-calendar-concept-overview
[exchange-powershell]: https://learn.microsoft.com/en-us/powershell/exchange/connect-exo-powershell-managed-identity
[ews-migration]: https://learn.microsoft.com/en-us/graph/migrate-exchange-web-services-overview
