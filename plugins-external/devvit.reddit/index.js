import { servePlugin } from "@daisy-dag/plugin-sdk";
import fs from "node:fs";
import { Reddit } from "@devvit/reddit";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

servePlugin({
  manifest,
  async execute(input, ctx) {
    const {
      action,
      subreddit,
      title,
      selftext,
      url,
      post_id,
      text,
      user_id,
      limit = 10,
    } = input;

    try {
      // Initialize Reddit client with credentials from config
      const reddit = new Reddit({
        clientId: ctx.config.reddit_client_id,
        clientSecret: ctx.config.reddit_client_secret,
        username: ctx.config.reddit_username,
        password: ctx.config.reddit_password,
        userAgent: "daisy-dag-plugin/0.1.0",
      });

      // Honor cancellation signal
      if (ctx.signal?.aborted) {
        throw new Error("Execution cancelled");
      }

      let result;

      switch (action) {
        case "submit_post": {
          if (!subreddit || !title) {
            throw new Error("subreddit and title are required for submit_post");
          }
          const subredditObj = reddit.getSubreddit(subreddit);
          result = await subredditObj.submitPost({
            title,
            text: selftext || undefined,
            url: url || undefined,
          });
          break;
        }

        case "submit_comment": {
          if (!post_id || !text) {
            throw new Error("post_id and text are required for submit_comment");
          }
          const post = await reddit.getPostById(post_id);
          result = await post.addComment({ text });
          break;
        }

        case "get_posts": {
          if (!subreddit) {
            throw new Error("subreddit is required for get_posts");
          }
          const subredditObj = reddit.getSubreddit(subreddit);
          const topPosts = await subredditObj.getTop({ limit });
          result = topPosts.map((post) => ({
            id: post.id,
            title: post.title,
            author: post.author?.name,
            score: post.score,
            url: post.url,
            created: post.createdAt,
          }));
          break;
        }

        case "get_post_by_id": {
          if (!post_id) {
            throw new Error("post_id is required for get_post_by_id");
          }
          const post = await reddit.getPostById(post_id);
          result = {
            id: post.id,
            title: post.title,
            author: post.author?.name,
            score: post.score,
            url: post.url,
            selftext: post.body,
            created: post.createdAt,
            subreddit: post.subredditName,
            numComments: post.numComments,
          };
          break;
        }

        case "get_posts_by_user_id": {
          if (!user_id) {
            throw new Error("user_id is required for get_posts_by_user_id");
          }
          const user = await reddit.getUser(user_id);
          const userPosts = await user.getOverview({ limit });
          result = userPosts
            .filter((item) => item.constructor.name === "Post")
            .map((post) => ({
              id: post.id,
              title: post.title,
              score: post.score,
              url: post.url,
              created: post.createdAt,
              subreddit: post.subredditName,
            }));
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        result: null,
        error: error.message,
      };
    }
  },
  async readyz() {
    return true;
  },
});
