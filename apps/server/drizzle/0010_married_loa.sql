PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_active_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_actor_id` text,
	`owner_item_id` text,
	`owner_token_id` text,
	`name` text NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`duration` text,
	`disabled` integer DEFAULT false NOT NULL,
	`transfer` integer DEFAULT true NOT NULL,
	`status_id` text,
	FOREIGN KEY (`owner_actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_active_effects`("id", "owner_actor_id", "owner_item_id", "owner_token_id", "name", "icon", "changes", "duration", "disabled", "transfer", "status_id") SELECT "id", "owner_actor_id", "owner_item_id", "owner_token_id", "name", "icon", "changes", "duration", "disabled", "transfer", "status_id" FROM `active_effects`;--> statement-breakpoint
DROP TABLE `active_effects`;--> statement-breakpoint
ALTER TABLE `__new_active_effects` RENAME TO `active_effects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `effects_actor_idx` ON `active_effects` (`owner_actor_id`);--> statement-breakpoint
CREATE INDEX `effects_token_idx` ON `active_effects` (`owner_token_id`);--> statement-breakpoint
-- Carry every token's conditions across as effect rows before the column goes.
-- One row per condition, no duration (they lasted until removed, and still do).
-- `changes` stays empty on purpose: a condition's mechanics are looked up from
-- CONDITION_EFFECTS by `status_id` rather than copied in here, so fixing what
-- "prone" does fixes every prone token instead of only the next one.
INSERT INTO `active_effects` (`id`, `owner_token_id`, `name`, `icon`, `changes`, `duration`, `disabled`, `transfer`, `status_id`)
SELECT lower(hex(randomblob(11))), `t`.`id`,
	upper(substr(`c`.`value`, 1, 1)) || substr(`c`.`value`, 2),
	'', '[]', NULL, false, true, `c`.`value`
FROM `tokens` `t`, json_each(`t`.`conditions`) `c`
WHERE json_valid(`t`.`conditions`);--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `conditions`;