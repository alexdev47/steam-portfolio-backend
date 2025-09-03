import passport from "passport";
import passportSteam from "passport-steam";
import { supa } from "./supabaseClient.js";
import dotenv from "dotenv";
dotenv.config();

const SteamStrategy = passportSteam.Strategy;

function assertEnv(name) {
  if (!process.env[name] || String(process.env[name]).trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
}

assertEnv("SESSION_SECRET");
assertEnv("SERVER_URL");
assertEnv("FRONTEND_URL");
assertEnv("SUPABASE_URL");
assertEnv("SUPABASE_SERVICE_ROLE");
assertEnv("STEAM_API_KEY");

// serialize / deserialize
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const { data, error } = await supa.from("users").select("*").eq("id", id).single();
  if (error) return done(error);
  done(null, data);
});

// Steam OpenID strategy
// ...
passport.use(
  new SteamStrategy(
    {
      returnURL: `${process.env.SERVER_URL}/auth/steam/return`,
      realm: process.env.SERVER_URL,
      apiKey: process.env.STEAM_API_KEY,
    },
    async (_identifier, profile, done) => {
      try {
        const steamid = profile._json.steamid;
        const name = profile.displayName;
        const avatar_url =
          profile.photos?.[2]?.value || profile.photos?.[0]?.value || null;

        // 1) робимо upsert без select/single
        const { error: upsertErr } = await supa
          .from("users")
          .upsert(
            { provider: "steam", steamid, name, avatar_url },
            { onConflict: "steamid" }
          );
        if (upsertErr) return done(upsertErr);

        // 2) окремим запитом забираємо рівно один запис по унікальному ключу
        const { data, error } = await supa
          .from("users")
          .select("*")
          .eq("steamid", steamid)
          .limit(1)
          .single(); // тепер точно 1 рядок
        if (error) return done(error);

        return done(null, data);
      } catch (e) {
        return done(e);
      }
    }
  )
);


export default passport;
