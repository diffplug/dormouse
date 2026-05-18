#!/usr/bin/env perl
# Patches absolute Windows paths in a Tauri-generated .nsi script so it can
# be rebuilt on macOS/Linux with makensis.
#
# Usage: perl patch-nsis-paths.pl <installer.nsi> <local-artifact-root>
#
# The script extracts the CI checkout root from MAINBINARYSRCPATH, then
# replaces all occurrences with the local artifact root, converting
# backslashes to forward slashes.

use strict;
use warnings;

my $nsi_file   = $ARGV[0] or die "Usage: $0 <installer.nsi> <local-artifact-root>\n";
my $local_root = $ARGV[1] or die "Usage: $0 <installer.nsi> <local-artifact-root>\n";

open my $fh, '<', $nsi_file or die "Cannot open $nsi_file: $!";
my $content = do { local $/; <$fh> };
close $fh;

# Extract CI checkout root from MAINBINARYSRCPATH.
# The path looks like: "D:\a\dormouse\dormouse\standalone\src-tauri\target\...\dormouse.exe"
# We want everything before \src-tauri\ (including \standalone) because
# actions/upload-artifact strips the common ancestor (standalone/) from paths.
my $ci_root;
if ($content =~ /MAINBINARYSRCPATH\s+"(.+?)\\src-tauri\\/) {
    $ci_root = $1;
} else {
    die "Could not extract CI checkout root from MAINBINARYSRCPATH in $nsi_file\n";
}
print "CI checkout root: $ci_root\n";
print "Local artifact root: $local_root\n";

# Count occurrences before replacement
my $count = 0;
while ($content =~ /\Q$ci_root\E/g) { $count++ }
print "Found $count path(s) to replace\n";

# Replace all occurrences of ci_root...<rest-of-path> with local_root/<rest>,
# converting backslashes to forward slashes in the <rest> portion.
$content =~ s/\Q$ci_root\E([^"]*)/
    my $rest = $1;
    $rest =~ s{\\}{\/}g;
    "$local_root$rest"
/ge;

# Remove the /a flag from File directives — it sets Windows file attributes
# and is silently skipped on non-Windows, causing files to not be included.
my $fa_count = 0;
$fa_count++ while $content =~ /\bFile\s+\/a\b/g;
$content =~ s/\bFile\s+\/a\b/File/g;
print "Removed $fa_count 'File /a' flags (unsupported on non-Windows)\n" if $fa_count;

open my $out, '>', $nsi_file or die "Cannot write $nsi_file: $!";
print $out $content;
close $out;

print "Done. Patched $count path(s).\n";
