ALTER TABLE `journal_entries` ADD `shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Carry the old grant-derived sharedness across, so entries already shown to
-- the party stay shown, then drop the grants that were standing in for it.
UPDATE `journal_entries` SET `shared` = 1 WHERE `id` IN (
	SELECT `document_id` FROM `ownership` WHERE `document_type` = 'journal'
);--> statement-breakpoint
DELETE FROM `ownership` WHERE `document_type` = 'journal';