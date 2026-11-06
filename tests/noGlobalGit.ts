// Unit tests run git as on GitHub's runner (#447, #448): with no global git config, so no user identity but a
// repository's own. A test whose Combwork code commits or merges sets its repository's user.name and user.email (or passes
// -c), or it fails here as it would on CI. /dev/null is git's null config (Git for Windows too): nothing to read, and
// nothing can be written to it, so no run or test can leave an identity there for the next. It stands for the user's
// ~/.gitconfig in every git a test starts, unless the test gives that child an environment of its own.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
