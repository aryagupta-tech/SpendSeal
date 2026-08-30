import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { Dashboard } from "./pages/Dashboard";
import { Approval } from "./pages/Approval";
import { Checkout } from "./pages/Checkout";
import { AuditPage } from "./pages/AuditPage";
import { Login } from "./pages/Login";
import { ShoppingTaskPage } from "./pages/ShoppingTaskPage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/login" element={<Login />} />
          <Route path="/approve/:id" element={<Approval />} />
          <Route path="/checkout/:token" element={<Checkout />} />
          <Route path="/audit/:id" element={<AuditPage />} />
          <Route path="/shopping/:id" element={<ShoppingTaskPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
