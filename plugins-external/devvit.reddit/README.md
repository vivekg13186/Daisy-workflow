# devvit.reddit Plugin

A Daisy-DAG plugin for Reddit integration using the Devvit API. This plugin enables submitting posts and comments, as well as fetching post data from Reddit.

## Features

- **Submit Posts**: Create new posts in a subreddit with text or link content
- **Submit Comments**: Reply to existing posts with comments
- **Get Posts**: Fetch top posts from a subreddit
- **Get Post by ID**: Retrieve detailed information about a specific post
- **Get Posts by User**: Fetch all posts created by a specific user

## Input Schema

All operations require an `action` parameter. Additional parameters depend on the action:

### submit_post
- `subreddit` (required): Target subreddit
- `title` (required): Post title
- `selftext` (optional): Post body text
- `url` (optional): Post URL for link posts

### submit_comment
- `post_id` (required): ID of the post to comment on
- `text` (required): Comment text

### get_posts
- `subreddit` (required): Subreddit to fetch posts from
- `limit` (optional): Number of posts to fetch (default: 10)

### get_post_by_id
- `post_id` (required): Reddit post ID

### get_posts_by_user_id
- `user_id` (required): Reddit username
- `limit` (optional): Number of posts to fetch (default: 10)

## Output Schema

All operations return an object with:
- `success` (boolean): Whether the operation succeeded
- `result` (object|array|string): Operation result (varies by action)
- `error` (string): Error message if operation failed

## Configuration

This plugin requires the following workspace configuration:

- `reddit_client_id`: Your Reddit application client ID
- `reddit_client_secret`: Your Reddit application client secret
- `reddit_username`: Reddit account username
- `reddit_password`: Reddit account password

### How to Get Reddit Credentials

1. Go to https://www.reddit.com/prefs/apps
2. Create a new application (select "script" type)
3. Copy the client ID (under the app name) and client secret
4. Use your Reddit account credentials

## Example Usage

```json
{
  "action": "submit_post",
  "subreddit": "test",
  "title": "My Test Post",
  "selftext": "This is the post body"
}
```
