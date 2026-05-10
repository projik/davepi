Add a private notes field to the `task` schema that's only visible
to admins:

- Name: `internalNotes`.
- Type: `String`.
- Field-level ACL: only the `admin` role can read it. Use the
  framework's per-field `acl.read` slot.

The field should be writable by regular owners (no `acl.create` /
`acl.update` restriction) so they can still set notes for their
own tasks — but the value should be stripped from responses for
anyone who isn't an admin.
