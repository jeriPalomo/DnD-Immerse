ALTER TABLE `actors` ADD `personality_traits` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `actors` ADD `ideals` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `actors` ADD `bonds` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `actors` ADD `flaws` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The Notes box was the only place to write a backstory, and its placeholder
-- said so. Renaming the section to Backstory without moving the text would
-- hide whatever anybody had already written.
UPDATE `actors` SET `backstory` = `notes`, `notes` = '' WHERE `backstory` = '' AND `notes` != '';