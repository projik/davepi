Add an ACL to the `task` schema so that only users with the
`admin` role can delete tasks. Regular users can still create,
read, and update their own tasks (the default behaviour) — only
DELETE is restricted via the framework's `acl.delete` slot.
