-- Run with: osascript apps/cite-plugins/word/test-field-result.applescript
-- Only creates and closes its own unsaved document.
tell application "Microsoft Word"
	set testDocument to make new document
	try
		set target to create range testDocument start 0 end 0
		create new field text range target field type field print date preserve formatting false
		set citationField to first field of text object of testDocument
		set content of field code of citationField to " ADDIN NEOREAD_TEMP "
		set show codes of citationField to false
		set content of result range of citationField to "{Citation}"
		set content of field code of citationField to " ADDIN NEOREAD_CITATION TEST "
		set show codes of citationField to false
		set content of result range of citationField to "[1]"
		if content of result range of citationField is not "[1]" then error "Citation result is outside the field"
		if show codes of citationField then error "Citation shows its internal code"
		set content of result range of citationField to "[2]"
		if content of result range of citationField is not "[2]" then error "Citation refresh did not replace the result"
		set bodyText to content of text object of testDocument
		if bodyText contains "{Citation}" or bodyText contains "[1]" then error "Placeholder or previous result leaked into document text"
		close testDocument saving no
		return "PASS: field result, hidden code, refresh, no leaked placeholder"
	on error failureMessage number failureNumber
		close testDocument saving no
		error failureMessage number failureNumber
	end try
end tell
