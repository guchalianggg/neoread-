// WPS ribbon callbacks. Each button runs one NeoRead citation command.
(function (root) {
  "use strict";

  const commands = [
    "addEditCitation",
    "addEditBibliography",
    "refresh",
    "setDocPrefs",
    "removeCodes",
  ];
  const images = {
    addEditCitation: "images/citation.svg",
    addEditBibliography: "images/bibliography.svg",
    refresh: "images/refresh.svg",
    setDocPrefs: "images/preferences.svg",
    removeCodes: "images/unlink.svg",
  };
  let running = false;

  function alertUser(message) {
    try {
      root.wps.WpsApplication().ActiveDocument.ActiveWindow.Activate();
    } catch (e) {
      /* Show the message anyway. */
    }
    root.alert(message);
  }

  root.NeoReadCiteOnAddinLoad = function (ribbonUI) {
    root.wps.ribbonUI = ribbonUI;
    return true;
  };

  root.NeoReadCiteGetImage = function (control) {
    return images[control.Id] || "";
  };

  root.NeoReadCiteOnAction = function (control) {
    const command = control.Id;
    if (!commands.includes(command) || running) return true;
    const app = root.wps.WpsApplication();
    if (!app.Documents.Count) {
      alertUser("请先打开一份文档。");
      return true;
    }
    const doc = root.NeoReadCiteWord.createDocument(app);
    running = true;
    root.NeoReadCiteProtocol.bootstrap(root.location.pathname)
      .then((post) =>
        root.NeoReadCiteProtocol.runCommand({
          command,
          documentId: doc.id(),
          client: "wps",
          document: doc,
          post,
        }),
      )
      .then((error) => {
        if (error) alertUser(error);
      })
      .catch((e) => alertUser(String((e && e.message) || e)))
      .finally(() => {
        running = false;
      });
    return true;
  };
})(typeof globalThis === "object" ? globalThis : this);
