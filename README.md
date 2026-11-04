# Going, Going, Goal!

A free live football transfer auction for 2 to 10 managers.

## Put it online for free

1. Create a free account at https://github.com.
2. Press **New repository**, name it `going-going-goal`, choose **Public**, then press **Create repository**.
3. Press **uploading an existing file**. Open this folder and drag everything inside it onto the page, including the `public` folder. Press **Commit changes**.
4. Sign up at https://render.com using **GitHub**.
5. Press **New**, then **Web Service**, and pick your `going-going-goal` repository.
6. Check these settings, then press **Deploy Web Service**:
   - Language: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
7. When it says **Live**, open the address at the top of the page. It ends in `onrender.com`.

## Play with friends

1. Open your address, type a name and press **Create friends lobby**.
2. Press **Copy invite link** and send it to your friends.
3. They open it, type a name and press **Join lobby**.
4. Press **Start the sale**.

Keep to the free plan and don't add a payment method. After 15 minutes with nobody playing, the site goes to sleep. The next person to open it waits about a minute while it wakes up.

## Try it on your own computer

If you have Node.js installed, run `node server.js` in this folder, then open http://localhost:3000.
