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
      login
      githubId
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

export const PromptQuery = graphql(`
  query Prompt($shelf: ID!, $id: ID!) {
    shelf(id: $shelf) {
      id
      viewerAccess {
        write
      }
      item(id: $id) {
        id
        kind
        title
        description
        tags
        body
        variables
        asCommand
        favourite
        revision
        updatedAt
        document
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

// One item.

export const ItemQuery = graphql(`
  query Item($shelf: ID!, $id: ID!) {
    shelf(id: $shelf) {
      id
      viewerAccess {
        write
      }
      item(id: $id) {
        id
        kind
        title
        description
        tags
        targets
        path
        body
        document
        revision
        createdAt
        updatedAt
        favourite
        source
        scanStatus
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
        coordinate {
          kind
          entry
          name
          message
        }
        dependents {
          requiredBy
          recommendedBy
          bundles
          profiles
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

export const ComposeQuery = graphql(`
  query Compose($shelf: ID!) {
    shelf(id: $shelf) {
      id
      registryUrl
      viewerAccess {
        write
        profiles
      }
      bundles
      profiles {
        id
        title
        document
      }
      snapshot {
        digest
      }
      files {
        path
        sha256
        size
      }
      items(limit: 1000) {
        total
        nodes {
          item {
            id
            kind
            title
            description
            tags
            revision
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

// Compile.

export const CompileQuery = graphql(`
  query Compile($shelf: ID!, $profile: ID!) {
    shelf(id: $shelf) {
      id
      registryUrl
      profile(id: $profile) {
        id
        title
        revision
        apmCoordinate
        document
        resolution {
          json
        }
        plan {
          errors {
            path
            message
          }
          plan {
            json
          }
        }
      }
      profiles {
        id
        title
      }
    }
  }
`);

export const ReportActivityMutation = graphql(`
  mutation ReportActivity($input: JSON!) {
    reportActivity(input: $input)
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
        githubId
        login
        scopes
        createdAt
      }
    }
  }
`);

export const GrantAccessMutation = graphql(`
  mutation GrantAccess($shelf: ID!, $login: String!, $scopes: [String!]!) {
    grantAccess(shelf: $shelf, login: $login, scopes: $scopes) {
      githubId
      login
      scopes
    }
  }
`);

export const RevokeAccessMutation = graphql(`
  mutation RevokeAccess($shelf: ID!, $githubId: ID!) {
    revokeAccess(shelf: $shelf, githubId: $githubId)
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
