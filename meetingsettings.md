# Meeting Preferences — Specs

## Vue d'ensemble

Page de configuration des preferences utilisateur pour l'enregistrement automatique des meetings. Deux onglets : **Automation preferences** et **Bot recorder preferences**.

---

## Onglet 1 : Automation Preferences

### Section globale

#### 1. Auto-record the following meetings in my calendar

Choix des meetings du calendrier synchronise a enregistrer automatiquement.

**Type** : Dropdown

**Options** :
- `All meetings` — enregistre tous les meetings detectes
- `Only meetings with external participants` — uniquement si au moins un participant a un domaine email different de l'organisation
- `None` — desactive l'auto-record

**Logique** :
- S'applique a toutes les `CalendarConnection` actives de l'utilisateur
- Le `calendar-sync-worker` consulte ce setting avant de creer un `Meeting` automatique
- Remplace le booleen `Calendar.autoRecord` actuel par un enum user-level

**Modele impacte** : Nouveau champ `autoRecordPolicy` sur un modele `UserMeetingPreferences` (a creer).

---

#### 2. Only record meetings I'm hosting

Filtre supplementaire : le bot ne rejoint que les meetings ou l'utilisateur est l'organisateur.

**Type** : Toggle (boolean)

**Logique** :
- Le `CalendarEvent` contient les donnees d'organisateur (champ `organizer` dans les attendees)
- Le sync worker verifie : `event.organizer.email === user.email`
- Si active et que l'utilisateur n'est pas host, pas de bot envoye
- Ce filtre s'applique en plus du `autoRecordPolicy`

---

#### 3. Auto-share the meeting recap

Apres transcription et generation du summary, le recap est automatiquement partage.

**Type** : Dropdown

**Options** :
- `To me only` — pas de partage, visible uniquement par le proprietaire
- `To all participants` — envoie un email/lien a tous les `Participant` du meeting
- `To my workspace` — publie dans l'org (tous les `OrganizationMember`)
- `Don't share` — desactive completement

**Logique** :
- Se declenche a la fin du job `GENERATE_SUMMARY` (status `COMPLETED`)
- Cree automatiquement des entrees `Share` avec les permissions adequates
- Envoie des notifications (email, webhook) aux destinataires

**Modele impacte** : `Share` existe deja. Ajouter l'automatisation dans le `summary-worker`.

---

### Section : For all internal meetings

Les meetings internes sont ceux ou **tous les participants** ont un email avec le meme domaine que l'organisation, ou sont membres de l'`Organization`.

#### 4. Generate the following Insights template (internal)

Choix du template de summary AI applique aux meetings internes.

**Type** : Dropdown

**Options** : Liste des `SummaryTemplate` de l'utilisateur + templates systeme

**Logique** :
- Quand le `summary-worker` traite un meeting interne, il utilise ce template
- Ordre de priorite :
  1. Template assigne directement au meeting
  2. Template par defaut interne (ce setting)
  3. Template systeme par defaut

**Modele impacte** : `SummaryTemplate` existe en DB. Ajouter un champ `defaultInternalTemplateId` sur `UserMeetingPreferences`.

---

#### 5. Add the meeting to the following folder (internal)

Classe automatiquement les meetings internes dans un dossier.

**Type** : Dropdown (liste des dossiers existants + creation)

**Logique** :
- Apres creation du `Meeting`, il est automatiquement lie au dossier configure
- Permet l'organisation sans action manuelle

**Nouveau modele requis** :
```prisma
model Folder {
  id               String    @id @default(cuid())
  userId           String
  organizationId   String?
  name             String
  color            String?
  parentId         String?   // nesting
  parent           Folder?   @relation("FolderTree", fields: [parentId], references: [id])
  children         Folder[]  @relation("FolderTree")
  isDefault        Boolean   @default(false)
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  meetings         MeetingFolder[]
}

model MeetingFolder {
  meetingId  String
  folderId   String
  meeting    Meeting  @relation(fields: [meetingId], references: [id])
  folder     Folder   @relation(fields: [folderId], references: [id])
  @@id([meetingId, folderId])
}
```

**Modele impacte** : Ajouter `defaultInternalFolderId` sur `UserMeetingPreferences`.

---

#### 6. Publish the meeting to workspace (internal)

Controle la visibilite du meeting dans le workspace partage de l'organisation.

**Type** : Dropdown

**Options** :
- `Everyone at [OrgName]` — visible par tous les membres de l'org
- `Only me` — prive
- `Specific people` — selection manuelle de membres

**Logique** :
- Definit le `visibility` du `Meeting` au moment de sa creation automatique
- Les requetes de listing filtrent selon cette visibilite
- Different du `Share` (lien externe) : ici c'est la visibilite intra-org

**Modele impacte** : Ajouter un enum `MeetingVisibility` (PRIVATE, WORKSPACE, SPECIFIC) et un champ `visibility` sur `Meeting`. Ajouter `defaultInternalVisibility` sur `UserMeetingPreferences`.

---

#### 7. Create a public link for the meeting (internal)

Genere automatiquement un lien de partage public pour chaque meeting interne.

**Type** : Toggle (boolean)

**Logique** :
- A la fin de l'enregistrement (status `COMPLETED`), cree automatiquement un `Share` :
  - `canView: true`, `canDownload: false`
  - Pas de password, pas d'expiry par defaut
- Le lien est disponible immediatement dans le dashboard

**Modele impacte** : `Share` existe. Ajouter `autoPublicLinkInternal` (boolean) sur `UserMeetingPreferences`.

---

### Section : For all external meetings

Les meetings externes sont ceux ou **au moins un participant** a un email d'un domaine different et n'est pas membre de l'organisation.

#### 8. Generate the following Insights template (external)

Identique au point 4, mais pour les meetings externes.

**Modele impacte** : Ajouter `defaultExternalTemplateId` sur `UserMeetingPreferences`.

---

#### 9. Add the meeting to the following folder (external)

Identique au point 5, mais pour les meetings externes.

**Modele impacte** : Ajouter `defaultExternalFolderId` sur `UserMeetingPreferences`.

---

#### 10. Publish the meeting to workspace (external)

Identique au point 6, mais pour les meetings externes.

**Modele impacte** : Ajouter `defaultExternalVisibility` sur `UserMeetingPreferences`.

---

#### 11. Create a public link for the meeting (external)

Identique au point 7, mais pour les meetings externes.

**Modele impacte** : Ajouter `autoPublicLinkExternal` (boolean) sur `UserMeetingPreferences`.

---

## Onglet 2 : Bot Recorder Preferences

Settings du bot lui-meme, appliques par defaut a tous les meetings.

#### 12. Bot display name

Nom affiche par le bot quand il rejoint un meeting.

**Type** : Text input

**Default** : `Aramis Recorder`

**Modele impacte** : Ajouter `defaultBotName` sur `UserMeetingPreferences`. Override possible par meeting via `Meeting.botName`.

---

#### 13. Recording format

Format de sortie de l'enregistrement.

**Type** : Dropdown

**Options** : `webm`, `mp4`, `mp3` (audio only)

**Default** : `webm`

---

#### 14. Recording resolution

Resolution video de l'enregistrement.

**Type** : Dropdown

**Options** : `1080p`, `720p`

**Default** : `1080p`

---

#### 15. Recording view

Mode de vue capture par le bot.

**Type** : Dropdown

**Options** : `speaker` (vue intervenant actif), `gallery` (vue grille)

**Default** : `speaker`

---

#### 16. Auto-leave on silence

Duree de silence apres laquelle le bot quitte automatiquement le meeting.

**Type** : Dropdown

**Options** : `5 min`, `10 min`, `15 min`, `30 min`, `Never`

**Default** : `10 min`

**Modele impacte** : Ajouter `silenceTimeoutMs` sur `UserMeetingPreferences`. Override le `BOT_CONFIG.SILENCE_TIMEOUT_MS` actuel.

---

#### 17. Entry chat message

Message envoye automatiquement par le bot dans le chat du meeting quand il rejoint.

**Type** : Text input (optionnel)

**Default** : vide (pas de message)

**Exemple** : "This meeting is being recorded by Aramis."

---

## Nouveau modele : UserMeetingPreferences

```prisma
model UserMeetingPreferences {
  id        String @id @default(cuid())
  userId    String @unique
  user      User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Section globale
  autoRecordPolicy       AutoRecordPolicy @default(ALL)
  onlyRecordAsHost       Boolean          @default(false)
  autoShareRecap         AutoSharePolicy  @default(ME_ONLY)

  // Internal meetings
  defaultInternalTemplateId  String?
  defaultInternalTemplate    SummaryTemplate? @relation("InternalTemplate", fields: [defaultInternalTemplateId], references: [id])
  defaultInternalFolderId    String?
  defaultInternalFolder      Folder? @relation("InternalFolder", fields: [defaultInternalFolderId], references: [id])
  defaultInternalVisibility  MeetingVisibility @default(WORKSPACE)
  autoPublicLinkInternal     Boolean           @default(true)

  // External meetings
  defaultExternalTemplateId  String?
  defaultExternalTemplate    SummaryTemplate? @relation("ExternalTemplate", fields: [defaultExternalTemplateId], references: [id])
  defaultExternalFolderId    String?
  defaultExternalFolder      Folder? @relation("ExternalFolder", fields: [defaultExternalFolderId], references: [id])
  defaultExternalVisibility  MeetingVisibility @default(WORKSPACE)
  autoPublicLinkExternal     Boolean           @default(true)

  // Bot recorder preferences
  defaultBotName        String  @default("Aramis Recorder")
  defaultRecordingFormat String @default("webm")
  defaultResolution     String @default("1080p")
  defaultRecordingView  String @default("speaker")
  silenceTimeoutMs      Int    @default(600000) // 10 min
  entryChatMessage      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum AutoRecordPolicy {
  ALL
  EXTERNAL_ONLY
  NONE
}

enum AutoSharePolicy {
  ME_ONLY
  ALL_PARTICIPANTS
  WORKSPACE
  NONE
}

enum MeetingVisibility {
  PRIVATE
  WORKSPACE
  SPECIFIC
}
```

---

## Classification Internal / External

**Algorithme de detection** :

```
function isInternalMeeting(event: CalendarEvent, org: Organization): boolean {
  const orgDomains = getOrgDomains(org) // domaines email de l'org
  const orgMemberEmails = getOrgMemberEmails(org)

  return event.attendees.every(attendee =>
    orgDomains.includes(getDomain(attendee.email)) ||
    orgMemberEmails.includes(attendee.email)
  )
}
```

Un meeting est **externe** des qu'au moins un participant ne correspond pas.
