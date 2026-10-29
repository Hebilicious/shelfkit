/**
 * Every GraphQL operation the SPA sends, in one place, typed against `apps/worker/schema.graphql`.
 * `moon run web:graphql-check` validates each against the SDL.
 */
import { graphql } from "./graphql.ts";

// Who is asking, and which shelves they reach.

export const ViewerQuery = graphql(`
  query Viewer {
    viewer {
      authenticated
      owner
      name
      principal
      keyId
      keyName
      scopes
      shelf
    }
    shelves {
      id
      name
      description
      itemCount
      profileCount
      public
    }
  }
`);

export const SignInMethodsQuery = graphql(`
  query SignInMethods {
    signInMethods {
      passkey
      github
    }
  }
`);

// One-time links: sign-in links and invites, opened at /link.

export const RedeemLinkMutation = graphql(`
  mutation RedeemLink($token: String!, $switchAccount: Boolean) {
    redeemLink(token: $token, switchAccount: $switchAccount) {
      name
      owner
      shelf
      offerPasskey
    }
  }
`);

export const SignInLinkQuery = graphql(`
  query SignInLink($token: String!) {
    signInLink(token: $token) {
      name
      switching
    }
  }
`);

export const InviteQuery = graphql(`
  query Invite($token: String!) {
    invite(token: $token) {
      shelf
      shelfName
      name
      scopes
      expiresAt
    }
  }
`);

export const CreateSignInLinkMutation = graphql(`
  mutation CreateSignInLink {
    createSignInLink {
      url
      expiresAt
    }
  }
`);

// The signed-in account's passkeys.

export const PasskeysQuery = graphql(`
  query Passkeys {
    passkeys {
      id
      label
      createdAt
      lastUsedAt
    }
  }
`);

export const RenamePasskeyMutation = graphql(`
  mutation RenamePasskey($id: ID!, $label: String!) {
    renamePasskey(id: $id, label: $label)
  }
`);

export const RemovePasskeyMutation = graphql(`
  mutation RemovePasskey($id: ID!, $allowLast: Boolean!) {
    removePasskey(id: $id, allowLast: $allowLast)
  }
`);

// Signing the CLI in through the browser: the approval page at /cli/<code>, and the keys CLIs hold.

export const CliLoginQuery = graphql(`
  query CliLogin($code: String!) {
    cliLogin(code: $code) {
      code
      device
      expiresAt
    }
  }
`);

export const ApproveCliLoginMutation = graphql(`
  mutation ApproveCliLogin($code: String!) {
    approveCliLogin(code: $code) {
      device
      name
    }
  }
`);

export const DenyCliLoginMutation = graphql(`
  mutation DenyCliLogin($code: String!) {
    denyCliLogin(code: $code)
  }
`);

export const CliKeysQuery = graphql(`
  query CliKeys {
    cliKeys {
      id
      name
      prefix
      createdAt
      lastUsedAt
    }
  }
`);

export const RevokeCliKeyMutation = graphql(`
  mutation RevokeCliKey($id: ID!) {
    revokeCliKey(id: $id)
  }
`);

export const SignOutMutation = graphql(`
  mutation SignOut {
    signOut
  }
`);

export const ShelfChangedSubscription = graphql(`
  subscription ShelfChanged($shelf: ID!) {
    shelfChanged(shelf: $shelf) {
      kind
      id
      at
    }
  }
`);

// The shelf and its inventory.

export const ShelfSummaryQuery = graphql(`
  query ShelfSummary($shelf: ID!) {
    shelf(id: $shelf) {
      id
      name
      description
      public
      registryUrl
      defaultProfile
      itemCount
      profileCount
      tags {
        tag
        count
      }
      viewerAccess {
        owner
        member
        read
        write
        profiles
      }
    }
  }
`);

export const InventoryQuery = graphql(`
  query Inventory(
    $shelf: ID!
    $query: String
    $kinds: [ItemKind!]
    $tags: [String!]
    $limit: Int
    $offset: Int
  ) {
    shelf(id: $shelf) {
      id
      items(
        query: $query
        kinds: $kinds
        tags: $tags
        limit: $limit
        offset: $offset
      ) {
        total
        nodes {
          snippet
          item {
            id
            kind
            title
            description
            tags
            revision
            scanStatus
            favourite
            coordinate {
              kind
              entry
              name
              message
            }
          }
        }
      }
    }
  }
`);

/**
 * Everything the shelf's lists and item pages show first, in one request: the summary and every item with its body
 * and item.json. Revisions, scans, and other files are the item's own query (`ItemQuery`), loaded when it opens.
 * The service pages `items` 200 at a time; `data/shelf.ts` asks for the rest when the shelf holds more.
 */
export const ShelfIndexQuery = graphql(`
  query ShelfIndex($shelf: ID!, $offset: Int) {
    shelf(id: $shelf) {
      id
      name
      description
      public
      registryUrl
      defaultProfile
      itemCount
      profileCount
      viewerAccess {
        owner
        member
        read
        write
        profiles
      }
      recents(limit: 8) {
        usedAt
        uses
        item {
          id
        }
      }
      items(limit: 200, offset: $offset) {
        total
        nodes {
          item {
            id
            kind
            title
            description
            tags
            targets
            revision
            updatedAt
            scanStatus
            favourite
            body
            variables
            asCommand
            document
            source
            coordinate {
              kind
              entry
              name
              message
            }
            drift {
              status
            }
            dependents {
              requiredBy
              recommendedBy
              bundles
              profiles
            }
          }
        }
      }
    }
  }
`);

// Prompts.

export const PromptsQuery = graphql(`
  query Prompts(
    $shelf: ID!
    $query: String
    $tags: [String!]
    $favouritesOnly: Boolean
  ) {
    shelf(id: $shelf) {
      id
      prompts(
        query: $query
        tags: $tags
        favouritesOnly: $favouritesOnly
        limit: 200
      ) {
        total
        nodes {
          snippet
          item {
            id
            title
            description
            tags
            favourite
            updatedAt
          }
        }
      }
      recents(limit: 8) {
        usedAt
        uses
        item {
          id
          kind
          title
        }
      }
    }
  }
`);

/** A prompt's files and history; the prompt itself is in `ShelfIndexQuery`. */
export const PromptQuery = graphql(`
  query Prompt($shelf: ID!, $id: ID!) {
    shelf(id: $shelf) {
      id
      item(id: $id) {
        id
        files {
          path
          contents
          encoding
        }
        revisions {
          revision
          createdAt
          message
          keyId
          files {
            path
            contents
            encoding
          }
        }
      }
    }
  }
`);

export const SetFavouriteMutation = graphql(`
  mutation SetFavourite($shelf: ID!, $item: ID!, $favourite: Boolean!) {
    setFavourite(shelf: $shelf, item: $item, favourite: $favourite)
  }
`);

export const RecordUseMutation = graphql(`
  mutation RecordUse($shelf: ID!, $item: ID!) {
    recordUse(shelf: $shelf, item: $item)
  }
`);

export const UpdatePromptMutation = graphql(`
  mutation UpdatePrompt(
    $shelf: ID!
    $id: ID!
    $title: String
    $description: String
    $tags: [String!]
    $body: String
    $variables: JSON
    $asCommand: Boolean
    $message: String
  ) {
    updatePrompt(
      shelf: $shelf
      id: $id
      title: $title
      description: $description
      tags: $tags
      body: $body
      variables: $variables
      asCommand: $asCommand
      message: $message
    ) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const WriteItemMutation = graphql(`
  mutation WriteItem(
    $shelf: ID!
    $document: JSON!
    $files: [ItemFileInput!]!
    $message: String
  ) {
    writeItem(
      shelf: $shelf
      document: $document
      files: $files
      message: $message
    ) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const DeleteItemMutation = graphql(`
  mutation DeleteItem($shelf: ID!, $id: ID!) {
    deleteItem(shelf: $shelf, id: $id) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

// One item: what the index does not carry. Its header and content come from `ShelfIndexQuery`.

export const ItemQuery = graphql(`
  query Item($shelf: ID!, $id: ID!) {
    shelf(id: $shelf) {
      id
      item(id: $id) {
        id
        files {
          path
          sha256
          size
          contents
          encoding
        }
        scans {
          id
          scanner
          verdict
          revision
          summary
          detailsUrl
          observed
          recordedAt
        }
        drift {
          status
          pinned
          latest
          checkedAt
          error
        }
        revisions {
          revision
          snapshot
          createdAt
          message
          keyId
          document
          files {
            path
            sha256
            contents
            encoding
          }
        }
      }
    }
  }
`);

// Profiles and the composer.

export const ProfilesQuery = graphql(`
  query Profiles($shelf: ID!) {
    shelf(id: $shelf) {
      id
      defaultProfile
      viewerAccess {
        write
        profiles
      }
      profiles {
        id
        title
        description
        revision
        version
        apmCoordinate
        document
        published {
          package
          versions
        }
        resolution {
          items {
            id
          }
          conflicts {
            severity
          }
        }
      }
    }
  }
`);

export const ShelfFilesQuery = graphql(`
  query ShelfFiles($shelf: ID!) {
    shelf(id: $shelf) {
      id
      snapshot {
        digest
      }
      files {
        path
        sha256
        size
      }
    }
  }
`);

export const PreviewProfileQuery = graphql(`
  query PreviewProfile($shelf: ID!, $document: JSON!) {
    shelf(id: $shelf) {
      id
      previewProfile(document: $document) {
        errors {
          path
          message
        }
        conflicts {
          severity
          code
          path
          message
        }
        plan {
          json
        }
        resolution {
          json
        }
      }
    }
  }
`);

export const StackMatchQuery = graphql(`
  query StackMatch($shelf: ID!, $packageJson: String!, $files: [String!]) {
    shelf(id: $shelf) {
      id
      stackMatch(packageJson: $packageJson, files: $files) {
        stacks
        markers
        profiles
        items {
          matched
          recommendedBy
          item {
            id
            kind
            title
          }
        }
      }
    }
  }
`);

export const SaveProfileMutation = graphql(`
  mutation SaveProfile($shelf: ID!, $document: JSON!, $message: String) {
    saveProfile(shelf: $shelf, document: $document, message: $message) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const DeleteProfileMutation = graphql(`
  mutation DeleteProfile($shelf: ID!, $id: ID!) {
    deleteProfile(shelf: $shelf, id: $id) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

// Records.

export const ActivityQuery = graphql(`
  query Activity($shelf: ID!, $profile: String, $before: DateTime) {
    shelf(id: $shelf) {
      id
      profiles {
        id
        title
        revision
      }
      activity(profile: $profile, before: $before, limit: 100) {
        id
        repository
        profile
        profileRevision
        apmYmlDigest
        outcome
        message
        commit
        keyId
        recordedAt
        stale
      }
    }
  }
`);

// Import.

export const ImportJobsQuery = graphql(`
  query ImportJobs($shelf: ID!) {
    shelf(id: $shelf) {
      id
      sources
      importJobs {
        id
        status
        source
        candidates
        picks
        imported
        warnings
        error
        createdAt
        updatedAt
      }
    }
  }
`);

export const StartImportMutation = graphql(`
  mutation StartImport($shelf: ID!, $source: JSON!) {
    startImport(shelf: $shelf, source: $source) {
      id
      status
    }
  }
`);

export const PickImportMutation = graphql(`
  mutation PickImport($shelf: ID!, $job: ID!, $picks: JSON!) {
    pickImport(shelf: $shelf, job: $job, picks: $picks) {
      id
      status
    }
  }
`);

export const IndexRepositoryMutation = graphql(`
  mutation IndexRepository(
    $shelf: ID!
    $repository: String!
    $ref: String
    $root: String
  ) {
    indexRepository(
      shelf: $shelf
      repository: $repository
      ref: $ref
      root: $root
    )
  }
`);

// Settings.

export const SettingsQuery = graphql(`
  query Settings($shelf: ID!) {
    shelf(id: $shelf) {
      id
      name
      public
      registryUrl
      sources
      databaseBytes
      viewerAccess {
        owner
        member
        write
      }
      profiles {
        id
        title
      }
      secretNames {
        name
        origin
        description
        configured
        createdAt
      }
    }
    shareLinks(shelf: $shelf) {
      id
      profile
      createdAt
      revokedAt
    }
  }
`);

// What only the owner sees: the shelf's keys for programs, and the GitHub accounts granted access in the browser.

export const AccessQuery = graphql(`
  query Access($shelf: ID!) {
    shelf(id: $shelf) {
      id
      keys {
        id
        name
        prefix
        scopes
        createdAt
        lastUsedAt
        revokedAt
      }
      grants {
        principal
        name
        kind
        scopes
        createdAt
      }
      invites {
        id
        name
        scopes
        createdAt
        expiresAt
        usedAt
        revokedAt
      }
    }
  }
`);

export const CreateInviteMutation = graphql(`
  mutation CreateInvite($shelf: ID!, $name: String!, $scopes: [String!]!) {
    createInvite(shelf: $shelf, name: $name, scopes: $scopes) {
      url
      invite {
        id
        name
      }
    }
  }
`);

export const RevokeInviteMutation = graphql(`
  mutation RevokeInvite($shelf: ID!, $id: ID!) {
    revokeInvite(shelf: $shelf, id: $id)
  }
`);

export const RemovePersonMutation = graphql(`
  mutation RemovePerson($shelf: ID!, $principal: ID!) {
    removePerson(shelf: $shelf, principal: $principal)
  }
`);

export const GrantAccessMutation = graphql(`
  mutation GrantAccess($shelf: ID!, $login: String!, $scopes: [String!]!) {
    grantAccess(shelf: $shelf, login: $login, scopes: $scopes) {
      principal
      name
      scopes
    }
  }
`);

export const RevokeAccessMutation = graphql(`
  mutation RevokeAccess($shelf: ID!, $principal: ID!) {
    revokeAccess(shelf: $shelf, principal: $principal)
  }
`);

export const CreateKeyMutation = graphql(`
  mutation CreateKey($shelf: ID!, $name: String!, $scopes: [String!]!) {
    createKey(shelf: $shelf, name: $name, scopes: $scopes) {
      secret
      key {
        id
        name
        prefix
        scopes
      }
    }
  }
`);

export const RevokeKeyMutation = graphql(`
  mutation RevokeKey($shelf: ID!, $id: ID!) {
    revokeKey(shelf: $shelf, id: $id)
  }
`);

export const SetVisibilityMutation = graphql(`
  mutation SetVisibility($shelf: ID!, $public: Boolean!) {
    setVisibility(shelf: $shelf, public: $public) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const PutSourceMutation = graphql(`
  mutation PutSource($shelf: ID!, $source: JSON!) {
    putSource(shelf: $shelf, source: $source) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const RemoveSourceMutation = graphql(`
  mutation RemoveSource($shelf: ID!, $id: String!) {
    removeSource(shelf: $shelf, id: $id) {
      ok
      reason
      missing
      changedItems
      changedProfiles
      removedItems
      errors {
        path
        message
      }
      snapshot {
        digest
      }
    }
  }
`);

export const PutSecretNameMutation = graphql(`
  mutation PutSecretName(
    $shelf: ID!
    $name: String!
    $origin: String!
    $description: String
  ) {
    putSecretName(
      shelf: $shelf
      name: $name
      origin: $origin
      description: $description
    )
  }
`);

export const RemoveSecretNameMutation = graphql(`
  mutation RemoveSecretName($shelf: ID!, $name: String!) {
    removeSecretName(shelf: $shelf, name: $name)
  }
`);

export const CreateShareLinkMutation = graphql(`
  mutation CreateShareLink($shelf: ID!, $profile: ID!) {
    createShareLink(shelf: $shelf, profile: $profile) {
      token
      link {
        id
        profile
      }
    }
  }
`);

export const RevokeShareLinkMutation = graphql(`
  mutation RevokeShareLink($shelf: ID!, $id: ID!) {
    revokeShareLink(shelf: $shelf, id: $id)
  }
`);

// Share.

export const SharedProfileQuery = graphql(`
  query SharedProfile($token: String!) {
    sharedProfile(token: $token) {
      id
      shelf
      title
      document
      items
      resolution
      errors {
        path
        message
      }
      plan {
        apmYml
        installCommand
        profileRevision
        files
      }
    }
  }
`);

// The profile editor: what the shelf index and the profiles list do not carry. Its items come from `ShelfIndexQuery`
// and its profiles from `ProfilesQuery`, so the editor lists every item however large the shelf.

export const ProfileEditorQuery = graphql(`
  query ProfileEditor($shelf: ID!) {
    shelf(id: $shelf) {
      id
      bundles
      snapshot {
        digest
      }
      files {
        path
        sha256
        size
      }
    }
  }
`);
