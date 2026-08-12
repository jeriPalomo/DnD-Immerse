ALTER TABLE `audio_state` ADD `resume_playlist_id` text;--> statement-breakpoint
ALTER TABLE `audio_state` ADD `resume_track_id` text;--> statement-breakpoint
ALTER TABLE `playlists` ADD `role` text DEFAULT 'none' NOT NULL;