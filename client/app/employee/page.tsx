"use client";

import React, { useMemo, useState, useEffect, useRef } from "react";
import Image from "next/image";
import * as XLSX from "xlsx";
import { UserRoundCog, Search, UserPlus, X, FileUp, Edit, Trash2, Download, Eye, EyeOff, MoreVertical, ChevronLeft, ChevronRight, Shield } from "lucide-react";
import { getEmployees, createEmployee, importEmployees, uploadEmployeePhoto, updateEmployee, deleteEmployee } from "@/lib/api";
import { InlineCatLoader } from '@/components/ui/CatLoader';
import {
  formatEmployeeTelForDisplay,
  formatTelLineForDb,
  formatTenDigitUsDisplay,
  parseTelLineFromDb,
  PHONE_EXT_MAX_DIGITS,
  PHONE_MAIN_MAX_DIGITS,
  validateEmployeePhoneInline,
  validateEmployeePhoneSubmit,
} from "@/lib/phoneFormat";
import {
  EMPLOYEE_PHOTO_ACCEPT,
  EMPLOYEE_PHOTO_EXTENSIONS_LABEL,
  EMPLOYEE_PHOTO_MAX_SIZE_LABEL,
  employeePhotoExtensionErrorMessage,
  employeePhotoSizeErrorMessage,
  employeePhotoSrc,
  isAllowedEmployeePhotoFile,
  isEmployeePhotoOverSize,
} from "@/lib/employeePhoto";
import DashboardHeader from "@/components/ui/Header";
import { SidebarLayout } from "@/components/sidebar/SidebarLayout";
import { useToast, ToastContainer } from "@/components/ui/Toast";
import { useAlertModal } from "@/components/ui/useAlertModal";
import { getErrorMessage } from "@/lib/unknownUtil";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  createEmployeeLoginAccount,
  updateUserAccount,
} from "@/lib/auth/authApi";
import type { AppRole, AuthUser } from "@/lib/auth/types";

/* ================= summary ================= */
const ITEMS_PER_PAGE = 8;

interface Employee {
  id: string;
  name: string;
  gmail: string;
  tel: string;
  positionType: string;
  employmentType: string;
  photo?: string | null;
  account?: AuthUser | null;
}

const extractNumber = (id: string) =>
  Number(id.replace(/\D/g, ""));

const EmployeeManagement = () => {
  const { isAdmin, user: currentUser, refreshUser } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const sortOrder = "newest" as const;
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    gmail: "",
    tel: "",
    telExt: "",
    positionType: "Technical" as "Technical" | "Management" | "Engineer",
    employmentType: "Full-Time",
    photo: null as string | null,
    username: "",
    password: "",
    role: "USER" as "USER" | "ADMIN",
    adminPassword: "",
  });
  const [addShowPassword, setAddShowPassword] = useState(false);
  const [addShowAdminPassword, setAddShowAdminPassword] = useState(false);
  const [addPhotoUploading, setAddPhotoUploading] = useState(false);
  const [addModalTab, setAddModalTab] = useState<"form" | "import">("form");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importRows, setImportRows] = useState<Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }>>([]);
  const [importSaving, setImportSaving] = useState(false);
  const [importParsing, setImportParsing] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    gmail: "",
    tel: "",
    telExt: "",
    positionType: "Technical" as "Technical" | "Management" | "Engineer",
    employmentType: "Full-Time",
    photo: null as string | null,
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editPhotoUploading, setEditPhotoUploading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [addFormErrors, setAddFormErrors] = useState<{
    name: string;
    gmail: string;
    tel: string;
    username: string;
    password: string;
    adminPassword: string;
  }>({ name: "", gmail: "", tel: "", username: "", password: "", adminPassword: "" });
  const [editFormErrors, setEditFormErrors] = useState<{ name: string; gmail: string; tel: string }>({ name: "", gmail: "", tel: "" });
  const [fetchError, setFetchError] = useState<string | null>(null);
  const { toasts, removeToast, success: toastSuccess, error: toastError, warning: toastWarning } = useToast();
  const { showConfirm, alertModal } = useAlertModal();

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [savingAccountId, setSavingAccountId] = useState<number | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<{
    emp: Employee;
    account: AuthUser;
    newRole: AppRole;
  } | null>(null);
  const [roleConfirmPassword, setRoleConfirmPassword] = useState("");
  const [roleConfirmShowPassword, setRoleConfirmShowPassword] = useState(false);
  const [roleConfirmSaving, setRoleConfirmSaving] = useState(false);
  const [createAccountFor, setCreateAccountFor] = useState<Employee | null>(null);
  const [createAccountForm, setCreateAccountForm] = useState({
    username: "",
    password: "",
    role: "USER" as AppRole,
    adminPassword: "",
  });
  const [createAccountShowPassword, setCreateAccountShowPassword] = useState(false);
  const [createAccountShowAdminPassword, setCreateAccountShowAdminPassword] = useState(false);
  const [createAccountSaving, setCreateAccountSaving] = useState(false);
  const addPhoneMainOverflowWarned = useRef(false);
  const addPhoneExtOverflowWarned = useRef(false);
  const editPhoneMainOverflowWarned = useRef(false);
  const editPhoneExtOverflowWarned = useRef(false);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const data = await getEmployees({ limit: 1000 });
      if (data.success && data.data && Array.isArray(data.data)) {
        setEmployees(
          data.data.map((row) => ({
            id: String(row.id),
            name: row.name || "",
            gmail: row.gmail || "",
            tel: row.tel || "",
            positionType: row.positionType || "Technical",
            employmentType: row.employmentType || "Full-Time",
            photo: row.photo ?? null,
            account: row.account
              ? {
                  id: row.account.id,
                  Username: row.account.Username,
                  Role: row.account.Role === "ADMIN" ? "ADMIN" : "USER",
                }
              : null,
          }))
        );
        setFetchError(null);
      } else {
        setEmployees([]);
        setFetchError((data.message || data.error) ?? null);
      }
    } catch (error) {
      console.error('Error fetching employees:', error);
      setEmployees([]);
      setFetchError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmployees();
  }, []);

  const patchEmployeeAccount = (employeeId: string, account: AuthUser | null) => {
    setEmployees((prev) =>
      prev.map((e) => (e.id === employeeId ? { ...e, account } : e))
    );
  };

  const requestRoleChange = (emp: Employee, newRole: AppRole) => {
    if (!isAdmin || !emp.account || emp.account.Role === newRole) return;
    if (currentUser?.id === emp.account.id && newRole !== "ADMIN") {
      toastError("You cannot demote your own account.");
      return;
    }
    setRoleConfirm({ emp, account: emp.account, newRole });
    setRoleConfirmPassword("");
    setRoleConfirmShowPassword(false);
  };

  const confirmRoleChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleConfirm || !isAdmin) return;
    const adminPassword = roleConfirmPassword.trim();
    if (!adminPassword) {
      toastError("Enter your password to confirm.");
      return;
    }
    const { emp, account, newRole } = roleConfirm;
    setRoleConfirmSaving(true);
    setSavingAccountId(account.id);
    const result = await updateUserAccount(account.id, { Role: newRole, adminPassword });
    if ("error" in result) {
      toastError(result.error);
    } else {
      const next = result.user ?? { ...account, Role: newRole };
      patchEmployeeAccount(emp.id, next);
      if (currentUser?.id === account.id) await refreshUser();
      toastSuccess(`Role updated to ${newRole}`);
      setRoleConfirm(null);
      setRoleConfirmPassword("");
    }
    setRoleConfirmSaving(false);
    setSavingAccountId(null);
  };

  const openCreateAccount = (emp: Employee) => {
    if (!isAdmin) return;
    const suggestion =
      (emp.gmail.includes("@") ? emp.gmail.split("@")[0] : "") ||
      emp.name.trim().replace(/\s+/g, ".").toLowerCase() ||
      "";
    setCreateAccountFor(emp);
    setCreateAccountForm({
      username: suggestion,
      password: "",
      role: "USER",
      adminPassword: "",
    });
    setCreateAccountShowPassword(false);
    setCreateAccountShowAdminPassword(false);
  };

  const handleCreateAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createAccountFor || !isAdmin) return;
    const username = createAccountForm.username.trim();
    if (!username || !createAccountForm.password) {
      toastError("Username and password are required.");
      return;
    }
    if (createAccountForm.password.length < 6) {
      toastError("Password must be at least 6 characters.");
      return;
    }
    if (createAccountForm.role === "ADMIN" && !createAccountForm.adminPassword.trim()) {
      toastError("Enter your password to grant admin role.");
      return;
    }
    setCreateAccountSaving(true);
    const result = await createEmployeeLoginAccount({
      employeeId: createAccountFor.id,
      Username: username,
      Password: createAccountForm.password,
      Role: createAccountForm.role,
      adminPassword:
        createAccountForm.role === "ADMIN" ? createAccountForm.adminPassword : undefined,
    });
    if ("error" in result) {
      toastError(result.error);
    } else {
      patchEmployeeAccount(result.row.employeeId, result.row.account);
      setCreateAccountFor(null);
      toastSuccess(`Login account created for ${createAccountFor.name}`);
    }
    setCreateAccountSaving(false);
  };

  useEffect(() => {
    if (addModalOpen && addModalTab === "form") {
      addPhoneMainOverflowWarned.current = false;
      addPhoneExtOverflowWarned.current = false;
    }
  }, [addModalOpen, addModalTab]);

  useEffect(() => {
    if (editingEmployee) {
      editPhoneMainOverflowWarned.current = false;
      editPhoneExtOverflowWarned.current = false;
    }
  }, [editingEmployee]);

  const openEditModal = (emp: Employee) => {
    setEditingEmployee(emp);
    const parsed = parseTelLineFromDb(emp.tel ?? "");
    setEditForm({
      name: emp.name ?? "",
      gmail: emp.gmail ?? "",
      tel: formatTenDigitUsDisplay(parsed.tel),
      telExt: parsed.telExt,
      positionType: (
        emp.positionType === "Management"
          ? "Management"
          : emp.positionType === "Engineer"
            ? "Engineer"
            : "Technical"
      ) as "Technical" | "Management" | "Engineer",
      employmentType: emp.employmentType ?? "Full-Time",
      photo: emp.photo ?? null,
    });
    setEditFormErrors({ name: "", gmail: "", tel: "" });
  };

  const handleEditPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isAllowedEmployeePhotoFile(file)) {
      toastError(employeePhotoExtensionErrorMessage());
      e.target.value = "";
      return;
    }
    if (isEmployeePhotoOverSize(file)) {
      toastError(employeePhotoSizeErrorMessage());
      e.target.value = "";
      return;
    }
    setEditPhotoUploading(true);
    try {
      const uploadRes = await uploadEmployeePhoto(file);
      if (uploadRes.success && uploadRes.path) {
        setEditForm((f) => ({ ...f, photo: uploadRes.path ?? null }));
      } else {
        toastError(uploadRes.message || "Upload image failed");
      }
    } catch (err) {
      console.error(err);
      toastError("Upload image failed");
    } finally {
      setEditPhotoUploading(false);
    }
  };

  const handleDeleteEmployee = () => {
    if (!editingEmployee) return;
    const emp = editingEmployee;
    showConfirm(
      `Delete "${emp.name}" from the employee list?`,
      async () => {
        setDeleteLoading(true);
        try {
          const res = await deleteEmployee(emp.id);
          if (res.success) {
            setEditingEmployee(null);
            await fetchEmployees();
            toastSuccess("Employee deleted successfully");
          } else {
            toastError(res.message || "Delete failed");
          }
        } catch (err) {
          console.error(err);
          toastError("An error occurred");
        } finally {
          setDeleteLoading(false);
        }
      },
      {
        title: "Delete employee",
        confirmText: "Delete",
        cancelText: "Cancel",
        dangerConfirm: true,
      }
    );
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmployee) return;
    const nameErr = validateEmpName(editForm.name);
    const gmailErr = validateEmpGmail(editForm.gmail);
    const telErr = validateEmployeePhoneSubmit(editForm.tel, editForm.telExt);
    setEditFormErrors({ name: nameErr, gmail: gmailErr, tel: telErr });
    if (nameErr || gmailErr || telErr) return;
    const nameTrim = editForm.name.trim();
    const telTrim = formatTelLineForDb(editForm.tel, editForm.telExt);
    const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/png?seed=${editingEmployee.id}`;
    const photoToSend = editForm.photo == null ? defaultAvatar : editForm.photo;
    setEditSaving(true);
    try {
      const res = await updateEmployee(editingEmployee.id, {
        name: nameTrim,
        gmail: editForm.gmail.trim(),
        tel: telTrim,
        positionType: editForm.positionType,
        employmentType: editForm.employmentType,
        // ถ้าลบรูป ให้ส่ง default avatar แทน (รองรับ DB ที่ em_picture = NOT NULL)
        photo: photoToSend,
      });
      if (res.success) {
        setEditingEmployee(null);
        await fetchEmployees();
        toastSuccess("Employee updated successfully");
      } else {
        toastError(res.message || "Employee update failed");
      }
    } catch (err) {
      console.error(err);
      toastError("Error updating employee");
    } finally {
      setEditSaving(false);
    }
  };

  const handleAddPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isAllowedEmployeePhotoFile(file)) {
      toastError(employeePhotoExtensionErrorMessage());
      e.target.value = "";
      return;
    }
    if (isEmployeePhotoOverSize(file)) {
      toastError(employeePhotoSizeErrorMessage());
      e.target.value = "";
      return;
    }
    setAddPhotoUploading(true);
    try {
      const uploadRes = await uploadEmployeePhoto(file);
      if (uploadRes.success && uploadRes.path) {
        setAddForm((f) => ({ ...f, photo: uploadRes.path ?? null }));
      } else {
        toastError(uploadRes.message || "Upload image failed");
      }
    } catch (err) {
      console.error(err);
      toastError("Upload image failed");
    } finally {
      setAddPhotoUploading(false);
    }
  };

  const validateEmpName = (val: string): string => {
    const t = val.trim();
    if (!t) return "Name is required.";
    if (!/^[a-zA-Z\u0E00-\u0E7F\s.]+$/.test(t)) return "Name must contain only letters and periods (e.g. Mr.).";
    if (t.length < 10) return "Name must be at least 10 characters.";
    return "";
  };
  const validateEmpGmail = (val: string): string => {
    const t = val.trim();
    if (!t) return "Email is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return "Please enter a valid email address.";
    return "";
  };
  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameErr = validateEmpName(addForm.name);
    const gmailErr = validateEmpGmail(addForm.gmail);
    const telErr = validateEmployeePhoneSubmit(addForm.tel, addForm.telExt);
    const usernameTrim = addForm.username.trim();
    const usernameErr = !usernameTrim ? "Username is required for login." : "";
    const passwordErr =
      !addForm.password
        ? "Password is required for login."
        : addForm.password.length < 6
          ? "Password must be at least 6 characters."
          : "";
    const adminPasswordErr =
      isAdmin && addForm.role === "ADMIN" && !addForm.adminPassword.trim()
        ? "Enter your password to grant ADMIN role."
        : "";
    setAddFormErrors({
      name: nameErr,
      gmail: gmailErr,
      tel: telErr,
      username: usernameErr,
      password: passwordErr,
      adminPassword: adminPasswordErr,
    });
    if (nameErr || gmailErr || telErr || usernameErr || passwordErr || adminPasswordErr) return;
    const nameTrim = addForm.name.trim();
    const telTrim = formatTelLineForDb(addForm.tel, addForm.telExt);
    setAddSaving(true);
    try {
      const res = await createEmployee({
        name: nameTrim,
        gmail: addForm.gmail.trim(),
        tel: telTrim,
        positionType: addForm.positionType,
        employmentType: addForm.employmentType,
        photo: addForm.photo || undefined,
        Username: usernameTrim,
        Password: addForm.password,
        Role: isAdmin ? addForm.role : "USER",
        adminPassword:
          isAdmin && addForm.role === "ADMIN" ? addForm.adminPassword : undefined,
      });
      if (res.success) {
        setAddModalOpen(false);
        setAddForm({
          name: "",
          gmail: "",
          tel: "",
          telExt: "",
          positionType: "Technical",
          employmentType: "Full-Time",
          photo: null,
          username: "",
          password: "",
          role: "USER",
          adminPassword: "",
        });
        setAddFormErrors({
          name: "",
          gmail: "",
          tel: "",
          username: "",
          password: "",
          adminPassword: "",
        });
        setAddShowPassword(false);
        setAddShowAdminPassword(false);
        await fetchEmployees();
        toastSuccess("Employee and login account added successfully");
      } else {
        toastError(res.message || "Employee add failed");
      }
    } catch (err) {
      console.error(err);
      toastError("Error adding employee");
    } finally {
      setAddSaving(false);
    }
  };

  // Parse CSV: accepts readable headers or no header if columns stay in order
  const parseCSV = (text: string): Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }> => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const rows: Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }> = [];
    const first = lines[0].toLowerCase();
    const hasHeader = first.includes("name") && (first.includes("gmail") || first.includes("email"));
    const start = hasHeader ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.replace(/^"|"$/g, "").trim());
      const name = parts[0] ?? "";
      const gmail = parts[1] ?? "";
      const tel = parts[2] ?? "";
      const positionType = (parts[3] ?? "Technical").trim() || "Technical";
      const employmentType = (parts[4] ?? "Full-Time").trim() || "Full-Time";
      if (name || gmail || tel) rows.push({ name, gmail, tel, positionType, employmentType });
    }
    return rows;
  };

  const normalizeHeader = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");

  const rowsFromSheetData = (jsonData: unknown[][]): Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }> => {
    if (!jsonData || jsonData.length === 0) return [];
    const rows: Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }> = [];
    const firstRow = (jsonData[0] || []).map((c) => String(c ?? "").trim());
    const firstRowLower = firstRow.map((c) => normalizeHeader(c));
    const hasHeader = firstRowLower.some((c) => c === "name") && (firstRowLower.some((c) => c === "gmail") || firstRowLower.some((c) => c === "email"));
    const start = hasHeader ? 1 : 0;

    const nameIdx = hasHeader ? firstRowLower.findIndex((c) => c === "name") : 0;
    const gmailIdx = hasHeader ? firstRowLower.findIndex((c) => c === "gmail" || c === "email") : 1;
    const telIdx = hasHeader ? firstRowLower.findIndex((c) => c === "tel" || c === "phone" || c === "phonenumber") : 2;
    const positionIdx = hasHeader ? firstRowLower.findIndex((c) => c.includes("position") && !c.includes("employment")) : 3;
    const employmentIdx = hasHeader ? firstRowLower.findIndex((c) => /employment/i.test(c.replace(/\s/g, ""))) : 4;

    const safe = (row: unknown[], i: number, d: string) => (i >= 0 && i < (row || []).length ? String(row[i] ?? "").trim() : "") || d;

    for (let i = start; i < jsonData.length; i++) {
      const row = (jsonData[i] || []) as unknown[];
      const name = safe(row, nameIdx >= 0 ? nameIdx : 0, "");
      const gmail = safe(row, gmailIdx >= 0 ? gmailIdx : 1, "");
      const tel = safe(row, telIdx >= 0 ? telIdx : 2, "").replace(/\s/g, "");
      const positionType = safe(row, positionIdx >= 0 ? positionIdx : 3, "Technical") || "Technical";
      const employmentType = safe(row, employmentIdx >= 0 ? employmentIdx : 4, "Full-Time") || "Full-Time";
      if (name || gmail || tel) rows.push({ name, gmail, tel, positionType, employmentType });
    }
    return rows;
  };

  const parseImportFile = (file: File): Promise<Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }>> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");
          if (isExcel) {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: "array", cellDates: false });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            // Use header: 1 to get all rows as array and not miss rows from used range
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", blankrows: true }) as unknown[][];
            resolve(rowsFromSheetData(jsonData));
          } else {
            const text = String(e.target?.result ?? "");
            resolve(parseCSV(text));
          }
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
        reader.readAsArrayBuffer(file);
      } else {
        reader.readAsText(file, "UTF-8");
      }
    });
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validExt = file.name.endsWith(".csv") || file.name.endsWith(".xlsx") || file.name.endsWith(".xls");
    if (!validExt) {
      toastWarning("Please select a CSV or Excel file (.csv, .xlsx, .xls)");
      return;
    }
    setImportFile(file);
    setImportRows([]);
    setImportParsing(true);
    try {
      const rows = await parseImportFile(file);
      setImportRows(rows);
    } catch (err) {
      console.error(err);
      toastError("Failed to parse file. Check format (columns: Name, Email, Phone_Number, Position_Type, Employment_Type).");
    } finally {
      setImportParsing(false);
    }
  };

  const validateImportRows = (rows: Array<{ name: string; gmail: string; tel: string; positionType: string; employmentType: string }>) => {
    const errors: string[] = [];
    const invalidRows = new Set<number>();
    const gmailCount: Record<string, number[]> = {};
    const nameAllowed = /^[a-zA-Z\u0E00-\u0E7F\s.]+$/;
    rows.forEach((r, i) => {
      const rowNum = i + 1;
      let hasError = false;
      const name = (r.name ?? "").trim();
      const gmail = (r.gmail ?? "").trim().toLowerCase();
      const telRaw = (r.tel ?? "").trim();
      const parsed = parseTelLineFromDb(telRaw.replace(/\s/g, ""));

      if (!name) {
        errors.push(`Row ${rowNum}: Please enter a Name`);
        hasError = true;
      } else if (!nameAllowed.test(name)) {
        errors.push(`Row ${rowNum}: Name must not contain numbers or special characters (period allowed, e.g. Mr.)`);
        hasError = true;
      }
      if (!gmail) {
        errors.push(`Row ${rowNum}: Please enter a Email`);
        hasError = true;
      } else {
        if (!gmailCount[gmail]) gmailCount[gmail] = [];
        gmailCount[gmail].push(rowNum);
      }
      if (!telRaw) {
        errors.push(`Row ${rowNum}: Please enter a phone number`);
        hasError = true;
      } else {
        const telErr = validateEmployeePhoneSubmit(parsed.tel, parsed.telExt);
        if (telErr) {
          errors.push(`Row ${rowNum}: ${telErr}`);
          hasError = true;
        }
      }
      if (hasError) invalidRows.add(i);
    });

    Object.entries(gmailCount).forEach(([email, rowNums]) => {
      if (rowNums.length > 1) {
        errors.push(`Email "${email}" is duplicated in rows ${rowNums.join(", ")}`);
        rowNums.forEach((rn) => invalidRows.add(rn - 1));
      }
    });
    return { errors, invalidRows };
  };

  const handleImportSubmit = async () => {
    if (importRows.length === 0) {
      toastWarning("No data to import, please select an Excel or CSV file");
      return;
    }
    const validation = validateImportRows(importRows);
    if (validation.errors.length > 0) {
      toastError("Data is not valid:\n\n" + validation.errors.join("\n"), 8000);
      return;
    }
    const valid = importRows.filter((r) => r.name.trim() && r.gmail.trim() && r.tel.trim());
    if (valid.length === 0) {
      toastWarning("No row with name, gmail, tel");
      return;
    }
    setImportSaving(true);
    try {
      const res = await importEmployees(
        valid.map((r) => {
          const p = parseTelLineFromDb((r.tel ?? "").trim().replace(/\s/g, ""));
          return {
            name: r.name.trim(),
            gmail: r.gmail.trim(),
            tel: formatTelLineForDb(p.tel, p.telExt),
            positionType: r.positionType || "Technical",
            employmentType: r.employmentType || "Full-Time",
          };
        })
      );
      if (res.success && res.data) {
        setAddModalOpen(false);
        setAddModalTab("form");
        setImportFile(null);
        setImportRows([]);
        await fetchEmployees();
        const msg = res.message || `Import successful: created ${res.data.created} employees${res.data.failed ? `, failed ${res.data.failed}` : ""}`;
        const errors = res.data.errors && res.data.errors.length > 0
          ? "\n\nFailed rows:\n" + res.data.errors.map((e: { row: number; message: string }) => `Row ${e.row}: ${e.message}`).join("\n")
          : "";
        toastSuccess(msg + errors, 8000);
      } else {
        toastError(res.message || "Import failed");
      }
    } catch (err) {
      console.error(err);
      toastError("Error importing employees");
    } finally {
      setImportSaving(false);
    }
  };

  const downloadEmployeeTemplate = () => {
    const header = ["Name", "Email", "Phone_Number", "Position_Type", "Employment_Type"];
    const exampleRow = [" Nena nana", "exampletcc-technology.com", "0812345678", "Technical", "Full-Time"];
    const ws = XLSX.utils.aoa_to_sheet([header, exampleRow]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Employees");
    XLSX.writeFile(wb, "employee_import_template.xlsx");
  };

  const importValidation = useMemo(() => validateImportRows(importRows), [importRows]);

  /* ================= filter ================= */
  const filteredEmployees = useMemo(() => {
    const q = searchTerm.toLowerCase();
    return employees.filter(
      (emp) =>
        (emp.name ?? '').toLowerCase().includes(q) ||
        (emp.gmail ?? '').toLowerCase().includes(q) ||
        (emp.tel ?? '').toLowerCase().includes(q) ||
        (emp.employmentType ?? '').toLowerCase().includes(q) ||
        (emp.id ?? '').toLowerCase().includes(q)
    );
  }, [searchTerm, employees]);

  /* ================= sort ================= */
  const sortedEmployees = useMemo(() => {
    const copy = [...filteredEmployees];
    copy.sort((a, b) => {
      const idA = extractNumber(a.id);
      const idB = extractNumber(b.id);
      return sortOrder === "newest" ? idB - idA : idA - idB;
    });
    return copy;
  }, [filteredEmployees, sortOrder]);

  /* ================= pagination ================= */
  const totalItems = sortedEmployees.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE) || 1);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedEmployees = sortedEmployees.slice(
    startIndex,
    startIndex + ITEMS_PER_PAGE
  );

  return (
    <SidebarLayout>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#F4F7FC] dark:bg-background">
      <DashboardHeader />

      <main className="flex min-h-0 w-full max-w-full flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 md:mt-0 mt-16">
          {/* Header */}
          <div className="mb-5 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-foreground sm:text-[1.75rem]">
              Employees{" "}
              <span className="font-bold text-slate-900 dark:text-foreground">
                ({loading ? "…" : employees.length})
              </span>
            </h1>

            <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
              <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/80 bg-white px-3 text-sm text-slate-500 shadow-[0_4px_14px_rgba(15,23,42,0.04)] dark:border-border dark:bg-card sm:min-w-[240px] sm:flex-none sm:w-72">
                <Search size={18} className="shrink-0 text-slate-400" />
                <input
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Search name, email, phone…"
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400 dark:text-foreground"
                />
              </div>
              <button
                type="button"
                onClick={() => { setAddModalOpen(true); setAddModalTab("form"); setImportFile(null); setImportRows([]); setAddFormErrors({ name: "", gmail: "", tel: "", username: "", password: "", adminPassword: "" }); }}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#4F86F7] px-5 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(79,134,247,0.35)] transition hover:bg-[#3f76e8]"
              >
                <UserPlus size={18} />
                Add Employee
              </button>
            </div>
          </div>

          {fetchError && (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {fetchError}
            </div>
          )}

          {/* Card list */}
          <div className="flex min-h-0 flex-1 flex-col">
            {loading ? (
              <div className="flex flex-1 items-center justify-center rounded-[20px] bg-white/70 dark:bg-card">
                <InlineCatLoader label="Loading..." className="py-16" />
              </div>
            ) : paginatedEmployees.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-[20px] bg-white px-6 py-16 text-sm text-slate-500 shadow-[0_4px_10px_rgba(0,0,0,0.05)] dark:bg-card dark:text-muted-foreground">
                No Employee found
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2 [scrollbar-width:thin]">
                {paginatedEmployees.map((emp) => (
                  <article
                    key={emp.id}
                    className={`relative grid grid-cols-1 items-center gap-4 rounded-[20px] bg-white px-5 py-4 shadow-[0_4px_10px_rgba(0,0,0,0.05)] dark:bg-card dark:shadow-none dark:ring-1 dark:ring-border ${
                      isAdmin
                        ? "lg:grid-cols-[minmax(200px,1.4fr)_minmax(110px,0.7fr)_minmax(100px,0.6fr)_minmax(120px,0.7fr)_minmax(220px,1.1fr)_2.75rem]"
                        : "lg:grid-cols-[minmax(220px,1.5fr)_minmax(120px,0.8fr)_minmax(110px,0.7fr)_minmax(180px,1fr)_2.75rem]"
                    } lg:gap-5`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 dark:bg-muted">
                        {emp.photo ? (
                          <Image
                            src={employeePhotoSrc(emp.photo) ?? ""}
                            alt=""
                            width={48}
                            height={48}
                            unoptimized
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <UserRoundCog className="h-5 w-5 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-slate-900 dark:text-foreground">
                          {emp.name || "—"}
                          {isAdmin && emp.account && currentUser?.id === emp.account.id ? (
                            <span className="ml-2 text-xs font-medium text-[#4F86F7]">You</span>
                          ) : null}
                        </p>
                        <p className="truncate text-sm text-slate-400">
                          {emp.gmail || "—"}
                          {isAdmin && emp.account?.Username ? (
                            <span className="text-slate-300"> · @{emp.account.Username}</span>
                          ) : null}
                        </p>
                      </div>
                    </div>

                    <div className="min-w-0">
                      <p className="text-xs text-slate-400">Phone</p>
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-foreground">
                        {formatEmployeeTelForDisplay(emp.tel) || "—"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="text-xs text-slate-400">Position</p>
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-foreground">
                        {emp.positionType || "—"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="mb-1 text-xs text-slate-400">Employment</p>
                      <div className="flex flex-nowrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-slate-800 dark:text-foreground">
                          {emp.employmentType || "—"}
                        </p>
                        <span
                          className={`inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-[11px] font-medium ${
                            emp.employmentType?.toLowerCase().includes("full")
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : emp.employmentType?.toLowerCase().includes("contract")
                                ? "border-sky-200 bg-sky-50 text-sky-700"
                                : "border-slate-200 bg-slate-50 text-slate-600"
                          }`}
                        >
                          {emp.positionType === "Management"
                            ? "Management"
                            : emp.positionType === "Engineer"
                              ? "Engineer"
                              : "Technical"}
                        </span>
                      </div>
                    </div>

                    {isAdmin ? (
                      <div className="min-w-0">
                        <p className="mb-1 text-xs text-slate-400">Role</p>
                        {emp.account ? (
                          <div className="flex flex-nowrap items-center gap-2">
                            <select
                              value={emp.account.Role}
                              disabled={
                                savingAccountId === emp.account.id ||
                                (currentUser?.id === emp.account.id && emp.account.Role === "ADMIN")
                              }
                              onChange={(e) =>
                                requestRoleChange(emp, e.target.value as AppRole)
                              }
                              className="h-8 shrink-0 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold tracking-wide text-slate-800 outline-none disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground"
                              aria-label={`Change role for ${emp.name}`}
                            >
                              <option value="USER">USER</option>
                              <option value="ADMIN">ADMIN</option>
                            </select>
                            <span
                              className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium ${
                                emp.account.Role === "ADMIN"
                                  ? "border-[#c5d4f8] bg-[#eef3ff] text-[#4F86F7]"
                                  : "border-slate-200 bg-slate-50 text-slate-600"
                              }`}
                            >
                              {emp.account.Role === "ADMIN" ? (
                                <>
                                  <Shield className="h-3.5 w-3.5" strokeWidth={2} />
                                  Admin
                                </>
                              ) : (
                                "User"
                              )}
                            </span>
                          </div>
                        ) : (
                          <span className="inline-flex h-8 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-[11px] font-medium text-amber-700">
                            No account
                          </span>
                        )}
                      </div>
                    ) : null}

                    <div className="absolute right-3 top-3 sm:static sm:justify-self-end">
                      <button
                        type="button"
                        onClick={() =>
                          setMenuOpenId((id) => (id === emp.id ? null : emp.id))
                        }
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-muted"
                        aria-label="Actions"
                      >
                        <MoreVertical size={18} />
                      </button>
                      {menuOpenId === emp.id ? (
                        <>
                          <button
                            type="button"
                            className="fixed inset-0 z-10 cursor-default"
                            aria-label="Close menu"
                            onClick={() => setMenuOpenId(null)}
                          />
                          <div className="absolute right-0 top-10 z-20 w-48 overflow-hidden rounded-xl border border-slate-100 bg-white py-1 shadow-lg dark:border-border dark:bg-card">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-foreground dark:hover:bg-muted"
                              onClick={() => {
                                setMenuOpenId(null);
                                openEditModal(emp);
                              }}
                            >
                              <Edit size={14} />
                              Edit
                            </button>
                            {isAdmin && !emp.account ? (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-foreground dark:hover:bg-muted"
                                onClick={() => {
                                  setMenuOpenId(null);
                                  openCreateAccount(emp);
                                }}
                              >
                                <UserPlus size={14} />
                                Create login
                              </button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}

            {/* Pagination */}
            <div className="mt-4 flex shrink-0 items-center justify-end gap-3 text-sm text-slate-500">
              <span>
                {totalItems === 0 ? "0-0" : `${startIndex + 1}-${Math.min(startIndex + ITEMS_PER_PAGE, totalItems)}`} of {totalItems}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[#4F86F7] transition hover:bg-white disabled:text-slate-300 disabled:hover:bg-transparent"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  disabled={currentPage >= totalPages || totalPages === 0}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[#4F86F7] transition hover:bg-white disabled:text-slate-300 disabled:hover:bg-transparent"
                  aria-label="Next page"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </div>

          {/* Add Employee Modal */}
          {addModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => !addSaving && !importSaving && setAddModalOpen(false)} />
              <div className={`relative flex w-full max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-card border border-border p-6 shadow-xl min-w-0 ${addModalTab === "import" ? "max-w-3xl" : "max-w-lg"}`}>
                <div className="mb-4 flex items-center justify-between flex-shrink-0">
                  <h3 className="text-lg font-semibold text-foreground">Add Employee</h3>
                  <button
                    type="button"
                    onClick={() => !addSaving && !importSaving && setAddModalOpen(false)}
                    className="p-2 text-muted-foreground hover:bg-muted rounded-lg hover:text-muted-foreground"
                  >
                    <X size={20} />
                  </button>
                </div>
                <div className="flex gap-2 mb-4 border-b border-border flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setAddModalTab("form")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg ${addModalTab === "form" ? "bg-indigo-50 text-indigo-600 border-b-2 border-indigo-500" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    Add one
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddModalTab("import")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg flex items-center gap-1.5 ${addModalTab === "import" ? "bg-indigo-50 text-indigo-600 border-b-2 border-indigo-500" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <FileUp size={16} />
                    Import
                  </button>
                </div>
                {addModalTab === "form" && (
                <form onSubmit={handleAddSubmit} className="space-y-4 overflow-y-auto overflow-x-hidden min-w-0 pr-8">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Profile Picture</label>
                    <div className="flex items-center gap-4">
                      <label className="relative flex h-20 w-20 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-border bg-muted hover:border-indigo-300 hover:bg-muted">
                        {addForm.photo ? (
                          <Image
                            src={employeePhotoSrc(addForm.photo) ?? ''}
                            alt=""
                            width={80}
                            height={80}
                            unoptimized
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground select-none">{addPhotoUploading ? "Uploading..." : "Select Image"}</span>
                        )}
                        <input type="file" accept={EMPLOYEE_PHOTO_ACCEPT} className="sr-only" aria-label="Select profile picture" onChange={handleAddPhotoChange} disabled={addPhotoUploading} />
                      </label>
                      {addForm.photo && (
                        <button type="button" onClick={() => setAddForm((f) => ({ ...f, photo: null }))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-50" title="Remove photo">
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                          Max {EMPLOYEE_PHOTO_MAX_SIZE_LABEL} · {EMPLOYEE_PHOTO_EXTENSIONS_LABEL}
                        </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Name <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      value={addForm.name}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^a-zA-Z\u0E00-\u0E7F\s.]/g, "");
                        setAddForm((f) => ({ ...f, name: v }));
                        setAddFormErrors((prev) => ({ ...prev, name: validateEmpName(v) }));
                      }}
                      onBlur={() => setAddFormErrors((prev) => ({ ...prev, name: validateEmpName(addForm.name) }))}
                      placeholder="e.g. Mr. First Name Last Name (letters and period, min 10)"
                      minLength={10}
                      className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 box-border ${addFormErrors.name ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                    />
                    {addFormErrors.name && <p className="mt-1 text-sm text-red-500">{addFormErrors.name}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Email <span className="text-red-500">*</span></label>
                    <input
                      type="email"
                      value={addForm.gmail}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAddForm((f) => {
                          const next = { ...f, gmail: v };
                          if (!f.username.trim() && v.includes("@")) {
                            next.username = v.split("@")[0] || "";
                          }
                          return next;
                        });
                        setAddFormErrors((prev) => ({ ...prev, gmail: validateEmpGmail(v) }));
                      }}
                      onBlur={() => setAddFormErrors((prev) => ({ ...prev, gmail: validateEmpGmail(addForm.gmail) }))}
                      placeholder="example@tcc-technology.com"
                      className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 box-border ${addFormErrors.gmail ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                    />
                    {addFormErrors.gmail && <p className="mt-1 text-sm text-red-500">{addFormErrors.gmail}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Phone <span className="text-red-500">*</span></label>
                    <div className="flex min-w-0 items-center gap-1 sm:gap-2">
                      <div className="relative min-w-0 flex-1">
                        <input
                          type="text"
                          inputMode="tel"
                          value={addForm.tel}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw.replace(/\D/g, "").length;
                            if (n > PHONE_MAIN_MAX_DIGITS) {
                              if (!addPhoneMainOverflowWarned.current) {
                                addPhoneMainOverflowWarned.current = true;
                                toastWarning(
                                  `Phone must be at most ${PHONE_MAIN_MAX_DIGITS} digits (already full)`,
                                  2600
                                );
                              }
                            } else {
                              addPhoneMainOverflowWarned.current = false;
                            }
                            const v = formatTenDigitUsDisplay(raw);
                            setAddForm((f) => ({ ...f, tel: v }));
                            setAddFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(v, addForm.telExt) }));
                          }}
                          onBlur={() => setAddFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(addForm.tel, addForm.telExt) }))}
                          placeholder="0xx-xxx-xxxx"
                          autoComplete="tel"
                          className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm tabular-nums outline-none focus:border-indigo-500 box-border ${addFormErrors.tel ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                        />
                      </div>
                      <span className="shrink-0 select-none text-base font-medium text-muted-foreground" aria-hidden>
                        -
                      </span>
                      <div className="relative w-[4.5rem] shrink-0 sm:w-24">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={addForm.telExt}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw.replace(/\D/g, "").length;
                            if (n > PHONE_EXT_MAX_DIGITS) {
                              if (!addPhoneExtOverflowWarned.current) {
                                addPhoneExtOverflowWarned.current = true;
                                toastWarning(
                                  `Extension must be at most ${PHONE_EXT_MAX_DIGITS} digits (already full)`,
                                  2600
                                );
                              }
                            } else {
                              addPhoneExtOverflowWarned.current = false;
                            }
                            const v = raw.replace(/\D/g, "").slice(0, PHONE_EXT_MAX_DIGITS);
                            setAddForm((f) => ({ ...f, telExt: v }));
                            setAddFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(addForm.tel, v) }));
                          }}
                          onBlur={() => setAddFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(addForm.tel, addForm.telExt) }))}
                          placeholder="Ext"
                          autoComplete="off"
                          aria-label="Extension (max 6 digits)"
                          title="Extension (max 6 digits)"
                          className={`w-full rounded-xl border-2 px-2.5 py-2.5 text-left text-sm tabular-nums outline-none focus:border-indigo-500 box-border ${addFormErrors.tel ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                        />
                      </div>
                    </div>
                    {addFormErrors.tel && <p className="mt-1 text-sm text-red-500">{addFormErrors.tel}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Position Type</label>
                    <select
                      value={addForm.positionType}
                      onChange={(e) => setAddForm((f) => ({ ...f, positionType: e.target.value as "Technical" | "Management" | "Engineer" }))}
                      className="w-full rounded-xl border-2 border-border bg-muted px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
                    >
                      <option value="Technical">Technical</option>
                      <option value="Management">Management</option>
                      <option value="Engineer">Engineer</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Employment Type</label>
                    <select
                      value={addForm.employmentType}
                      onChange={(e) => setAddForm((f) => ({ ...f, employmentType: e.target.value }))}
                      className="w-full rounded-xl border-2 border-border bg-muted px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
                    >
                      <option value="Full-Time">Full-Time</option>
                      <option value="Contract">Contract</option>
                      <option value="Part-Time">Part-Time</option>
                    </select>
                  </div>

                  <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Login account (required)
                    </p>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-muted-foreground">Username</label>
                      <input
                        type="text"
                        required
                        autoComplete="off"
                        value={addForm.username}
                        onChange={(e) => {
                          const v = e.target.value;
                          setAddForm((f) => ({ ...f, username: v }));
                          setAddFormErrors((prev) => ({
                            ...prev,
                            username: v.trim() ? "" : "Username is required for login.",
                          }));
                        }}
                        placeholder="Login username"
                        className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 box-border ${addFormErrors.username ? "border-red-400 bg-red-50/50" : "border-border bg-card"}`}
                      />
                      {addFormErrors.username && (
                        <p className="mt-1 text-sm text-red-500">{addFormErrors.username}</p>
                      )}
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-muted-foreground">Password</label>
                      <div className="relative">
                        <input
                          type={addShowPassword ? "text" : "password"}
                          required
                          minLength={6}
                          autoComplete="new-password"
                          value={addForm.password}
                          onChange={(e) => {
                            const v = e.target.value;
                            setAddForm((f) => ({ ...f, password: v }));
                            setAddFormErrors((prev) => ({
                              ...prev,
                              password: !v
                                ? "Password is required for login."
                                : v.length < 6
                                  ? "Password must be at least 6 characters."
                                  : "",
                            }));
                          }}
                          placeholder="At least 6 characters"
                          className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 pr-10 text-sm outline-none focus:border-indigo-500 box-border ${addFormErrors.password ? "border-red-400 bg-red-50/50" : "border-border bg-card"}`}
                        />
                        <button
                          type="button"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setAddShowPassword((v) => !v)}
                          aria-label={addShowPassword ? "Hide password" : "Show password"}
                        >
                          {addShowPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {addFormErrors.password && (
                        <p className="mt-1 text-sm text-red-500">{addFormErrors.password}</p>
                      )}
                    </div>
                    {isAdmin ? (
                      <div>
                        <label className="mb-1 block text-sm font-medium text-muted-foreground">Role</label>
                        <select
                          value={addForm.role}
                          onChange={(e) =>
                            setAddForm((f) => ({
                              ...f,
                              role: e.target.value as "USER" | "ADMIN",
                              adminPassword: e.target.value === "ADMIN" ? f.adminPassword : "",
                            }))
                          }
                          className="w-full rounded-xl border-2 border-border bg-card px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
                        >
                          <option value="USER">USER — standard access</option>
                          <option value="ADMIN">ADMIN — full access</option>
                        </select>
                      </div>
                    ) : null}
                    {isAdmin && addForm.role === "ADMIN" ? (
                      <div>
                        <label className="mb-1 block text-sm font-medium text-muted-foreground">
                          Your password <span className="font-normal">(confirm ADMIN)</span>
                        </label>
                        <div className="relative">
                          <input
                            type={addShowAdminPassword ? "text" : "password"}
                            required
                            autoComplete="current-password"
                            value={addForm.adminPassword}
                            onChange={(e) => {
                              const v = e.target.value;
                              setAddForm((f) => ({ ...f, adminPassword: v }));
                              setAddFormErrors((prev) => ({
                                ...prev,
                                adminPassword: v.trim() ? "" : "Enter your password to grant ADMIN role.",
                              }));
                            }}
                            placeholder="Enter your password"
                            className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 pr-10 text-sm outline-none focus:border-indigo-500 box-border ${addFormErrors.adminPassword ? "border-red-400 bg-red-50/50" : "border-border bg-card"}`}
                          />
                          <button
                            type="button"
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setAddShowAdminPassword((v) => !v)}
                            aria-label={addShowAdminPassword ? "Hide password" : "Show password"}
                          >
                            {addShowAdminPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {addFormErrors.adminPassword && (
                          <p className="mt-1 text-sm text-red-500">{addFormErrors.adminPassword}</p>
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => !addSaving && setAddModalOpen(false)}
                      className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={addSaving}
                      className="flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-60"
                    >
                      <UserPlus size={16} />
                      {addSaving ? "Saving..." : "Add Employee"}
                    </button>
                  </div>
                </form>
                )}
                {addModalTab === "import" && (
                  <div className="flex flex-col gap-4 overflow-y-auto min-h-0">
                    {/* File Format Guide */}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-bold text-blue-800">File Format Guide</h4>
                        <span className="inline-flex items-center gap-3">
                          <button
                            type="button"
                            onClick={downloadEmployeeTemplate}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Excel (.xlsx)
                          </button>
                        </span>
                      </div>
                      <div className="text-xs text-blue-700 space-y-1">
                        <p><strong>Required columns in the file:</strong></p>
                        <ul className="ml-4 list-disc space-y-0.5">
                          <li><strong>Name</strong> = employee name</li>  
                          <li><strong>Email</strong> = email address</li>
                          <li><strong>Phone_Number</strong> = 8–10 digits (0xx-xxx-xxxx), optional extension (up to 6 digits) e.g. <code className="bg-blue-100 px-1 rounded">0812345678-123456</code></li>
                          <li><strong>Position_Type</strong> = Technical, Management, or Engineer</li>
                          <li><strong>Employment_Type</strong> = Full-Time, Contract, or Part-time</li>
                        </ul>
                        <p className="mt-2 text-[10px] text-blue-600">
                          <strong>Note:</strong> If your file includes a header row, use these exact column names: <strong>Name</strong>, <strong>Email</strong>, <strong>Phone_Number</strong>, <strong>Position_Type</strong>, and <strong>Employment_Type</strong>.
                        </p>
                      </div>
                    </div>

                    {/* File Upload */}
                    <div className="border-2 border-dashed border-border rounded-xl p-4 text-center hover:border-indigo-400 transition-colors">
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleImportFileChange}
                        className="sr-only"
                        aria-label="Select Excel or CSV file"
                        id="employee-excel-file-input"
                        disabled={importParsing}
                      />
                      <label
                        htmlFor="employee-excel-file-input"
                        className="cursor-pointer flex flex-col items-center gap-2"
                      >
                        <div className="p-3 bg-indigo-100 rounded-full">
                          <Download size={24} className="text-indigo-600" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-muted-foreground">
                            Click to upload Excel/CSV file
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Supports .xlsx, .xls, and .csv formats
                          </p>
                        </div>
                      </label>
                    </div>

                    {importParsing && <p className="text-xs text-muted-foreground">Parsing file...</p>}
                    {importFile && !importParsing && <p className="text-xs text-muted-foreground truncate w-full">File: {importFile.name}</p>}
                    {importRows.length > 0 && (
                      <>
                        <p className="text-sm font-medium text-muted-foreground">Preview ({importRows.length} row{importRows.length !== 1 ? "s" : ""})</p>
                        {importValidation.errors.length > 0 && (
                          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                            <p className="font-semibold mb-1">Invalid data:</p>
                            <ul className="list-disc list-inside space-y-0.5">
                              {importValidation.errors.map((msg, i) => (
                                <li key={i}>{msg}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className={`border border-border rounded-lg overflow-auto bg-card ${importRows.length <= 8 ? "min-h-0" : "max-h-[50vh]"} min-h-[140px]`}>
                          <table className="min-w-full text-xs border-collapse">
                            <thead className="bg-muted sticky top-0 z-10">
                              <tr>
                                <th className="px-3 py-1.5 text-left border-b border-border font-semibold text-muted-foreground whitespace-nowrap">Name</th>
                                <th className="px-3 py-1.5 text-left border-b border-border font-semibold text-muted-foreground whitespace-nowrap">Email</th>
                                <th className="px-3 py-1.5 text-left border-b border-border font-semibold text-muted-foreground whitespace-nowrap">Tel</th>
                                <th className="px-3 py-1.5 text-left border-b border-border font-semibold text-muted-foreground whitespace-nowrap">Position</th>
                                <th className="px-3 py-1.5 text-left border-b border-border font-semibold text-muted-foreground whitespace-nowrap">Employment</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importRows.map((r, i) => (
                                <tr key={i} className={`border-b border-border hover:bg-muted ${importValidation.invalidRows.has(i) ? "bg-red-50" : ""}`}>
                                  <td className="px-3 py-1.5 text-foreground">{r.name || "—"}</td>
                                  <td className="px-3 py-1.5 text-foreground">{r.gmail || "—"}</td>
                                  <td className="px-3 py-1.5 text-foreground">{r.tel || "—"}</td>
                                  <td className="px-3 py-1.5 text-muted-foreground">{r.positionType || "—"}</td>
                                  <td className="px-3 py-1.5 text-muted-foreground">{r.employmentType || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => !importSaving && setAddModalOpen(false)}
                            className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleImportSubmit}
                            disabled={importSaving || importValidation.errors.length > 0}
                            className="flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            <FileUp size={16} />
                            {importSaving
                              ? "Importing..."
                              : importValidation.errors.length > 0
                                ? "Fix errors before importing"
                                : `Import ${importRows.filter((r) => r.name.trim() && r.gmail.trim() && r.tel.trim()).length} employees`}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Edit Employee Modal */}
          {editingEmployee && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => !editSaving && setEditingEmployee(null)} />
              <div className="relative flex w-full max-w-lg max-h-[90vh] flex-col rounded-2xl bg-card border border-border shadow-xl">
                <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-6 py-4">
                  <h3 className="text-lg font-semibold text-foreground">Edit Employee</h3>
                  <button
                    type="button"
                    onClick={() => !editSaving && setEditingEmployee(null)}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-muted-foreground"
                    aria-label="Close"
                  >
                    <X size={20} />
                  </button>
                </div>
                <form onSubmit={handleEditSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-6 py-4 pr-8 min-w-0">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Profile Picture</label>
                    <div className="flex items-center gap-4">
                      <label className="relative flex h-20 w-20 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-border bg-muted hover:border-indigo-300 hover:bg-muted">
                        {editForm.photo ? (
                          <Image
                            src={employeePhotoSrc(editForm.photo) ?? ''}
                            alt=""
                            width={80}
                            height={80}
                            unoptimized
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground select-none">{editPhotoUploading ? "Uploading..." : "Select Image"}</span>
                        )}
                        <input type="file" accept={EMPLOYEE_PHOTO_ACCEPT} className="sr-only" aria-label="Select Profile Picture" onChange={handleEditPhotoChange} disabled={editPhotoUploading} />
                      </label>
                      {editForm.photo && (
                        <button type="button" onClick={() => setEditForm((f) => ({ ...f, photo: null }))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-50" title="Remove photo">
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                          Max {EMPLOYEE_PHOTO_MAX_SIZE_LABEL} · {EMPLOYEE_PHOTO_EXTENSIONS_LABEL}
                        </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Name <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      value={editForm.name}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^a-zA-Z\u0E00-\u0E7F\s.]/g, "");
                        setEditForm((f) => ({ ...f, name: v }));
                        setEditFormErrors((prev) => ({ ...prev, name: validateEmpName(v) }));
                      }}
                      onBlur={() => setEditFormErrors((prev) => ({ ...prev, name: validateEmpName(editForm.name) }))}
                      placeholder="e.g. Mr. First Name Last Name (letters and period, min 10)"
                      minLength={10}
                      className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 box-border ${editFormErrors.name ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                    />
                    {editFormErrors.name && <p className="mt-1 text-sm text-red-500">{editFormErrors.name}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Email <span className="text-red-500">*</span></label>
                    <input
                      type="email"
                      value={editForm.gmail}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditForm((f) => ({ ...f, gmail: v }));
                        setEditFormErrors((prev) => ({ ...prev, gmail: validateEmpGmail(v) }));
                      }}
                      onBlur={() => setEditFormErrors((prev) => ({ ...prev, gmail: validateEmpGmail(editForm.gmail) }))}
                      placeholder="example@tcc-technology.com"
                      className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none focus:border-indigo-500 box-border ${editFormErrors.gmail ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                    />
                    {editFormErrors.gmail && <p className="mt-1 text-sm text-red-500">{editFormErrors.gmail}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Phone <span className="text-red-500">*</span></label>
                    <div className="flex min-w-0 items-center gap-1 sm:gap-2">
                      <div className="relative min-w-0 flex-1">
                        <input
                          type="text"
                          inputMode="tel"
                          value={editForm.tel}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw.replace(/\D/g, "").length;
                            if (n > PHONE_MAIN_MAX_DIGITS) {
                              if (!editPhoneMainOverflowWarned.current) {
                                editPhoneMainOverflowWarned.current = true;
                                toastWarning(
                                  `Phone main must be at most ${PHONE_MAIN_MAX_DIGITS} digits (already full)`,
                                  2600
                                );
                              }
                            } else {
                              editPhoneMainOverflowWarned.current = false;
                            }
                            const v = formatTenDigitUsDisplay(raw);
                            setEditForm((f) => ({ ...f, tel: v }));
                            setEditFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(v, editForm.telExt) }));
                          }}
                          onBlur={() => setEditFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(editForm.tel, editForm.telExt) }))}
                          placeholder="0xx-xxx-xxxx"
                          autoComplete="tel"
                          className={`w-full max-w-full rounded-xl border-2 px-4 py-2.5 text-sm tabular-nums outline-none focus:border-indigo-500 box-border ${editFormErrors.tel ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                        />
                      </div>
                      <span className="shrink-0 select-none text-base font-medium text-muted-foreground" aria-hidden>
                        -
                      </span>
                      <div className="relative w-[4.5rem] shrink-0 sm:w-24">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={editForm.telExt}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw.replace(/\D/g, "").length;
                            if (n > PHONE_EXT_MAX_DIGITS) {
                              if (!editPhoneExtOverflowWarned.current) {
                                editPhoneExtOverflowWarned.current = true;
                                toastWarning(
                                  `Extension must be at most ${PHONE_EXT_MAX_DIGITS} digits (already full)`,
                                  2600
                                );
                              }
                            } else {
                              editPhoneExtOverflowWarned.current = false;
                            }
                            const v = raw.replace(/\D/g, "").slice(0, PHONE_EXT_MAX_DIGITS);
                            setEditForm((f) => ({ ...f, telExt: v }));
                            setEditFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(editForm.tel, v) }));
                          }}
                          onBlur={() => setEditFormErrors((prev) => ({ ...prev, tel: validateEmployeePhoneInline(editForm.tel, editForm.telExt) }))}
                          placeholder="Ext"
                          autoComplete="off"
                          aria-label="Extension (max 6 digits)"
                          title="Extension (max 6 digits)"
                          className={`w-full rounded-xl border-2 px-2.5 py-2.5 text-left text-sm tabular-nums outline-none focus:border-indigo-500 box-border ${editFormErrors.tel ? "border-red-400 bg-red-50/50" : "border-border bg-muted"}`}
                        />
                      </div>
                    </div>
                    {editFormErrors.tel && <p className="mt-1 text-sm text-red-500">{editFormErrors.tel}</p>}
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Position Type</label>
                    <select
                      value={editForm.positionType}
                      onChange={(e) => setEditForm((f) => ({ ...f, positionType: e.target.value as "Technical" | "Management" | "Engineer" }))}
                      className="w-full rounded-xl border-2 border-border bg-muted px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
                    >
                      <option value="Technical">Technical</option>
                      <option value="Management">Management</option>
                      <option value="Engineer">Engineer</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-muted-foreground">Employment Type</label>
                    <select
                      value={editForm.employmentType}
                      onChange={(e) => setEditForm((f) => ({ ...f, employmentType: e.target.value }))}
                      className="w-full rounded-xl border-2 border-border bg-muted px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
                    >
                      <option value="Full-Time">Full-Time</option>
                      <option value="Contract">Contract</option>
                      <option value="Part-Time">Part-Time</option>
                    </select>
                  </div>
                  </div>
                  <div className="flex flex-shrink-0 justify-between border-t border-border px-6 py-4">
                    <button
                      type="button"
                      onClick={handleDeleteEmployee}
                      disabled={editSaving || deleteLoading}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-50"
                      title="Delete employee"
                    >
                      <Trash2 size={18} />
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => !editSaving && !deleteLoading && setEditingEmployee(null)}
                        className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={editSaving}
                        className="flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-60"
                      >
                        <Edit size={16} />
                        {editSaving ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          )}
        </main>
      </div>
      {alertModal}
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {roleConfirm && isAdmin ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close"
            onClick={() => !roleConfirmSaving && setRoleConfirm(null)}
          />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
            <div className="flex items-start justify-between border-b border-border px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Confirm role change</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Change &quot;{roleConfirm.emp.name}&quot; from {roleConfirm.account.Role} to{" "}
                  {roleConfirm.newRole}
                </p>
              </div>
              <button
                type="button"
                onClick={() => !roleConfirmSaving && setRoleConfirm(null)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={(e) => void confirmRoleChange(e)} className="space-y-4 px-6 py-5">
              <p className="text-sm text-muted-foreground">
                Enter your password to confirm this role change.
              </p>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Your password</label>
                <div className="relative">
                  <input
                    type={roleConfirmShowPassword ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={roleConfirmPassword}
                    onChange={(e) => setRoleConfirmPassword(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-4 py-2.5 pr-10 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    placeholder="Enter your password"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    onClick={() => setRoleConfirmShowPassword((v) => !v)}
                    aria-label={roleConfirmShowPassword ? "Hide password" : "Show password"}
                  >
                    {roleConfirmShowPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  disabled={roleConfirmSaving}
                  onClick={() => setRoleConfirm(null)}
                  className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={roleConfirmSaving}
                  className="rounded-xl bg-[#4F86F7] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f76e8] disabled:opacity-60"
                >
                  {roleConfirmSaving ? "Confirming…" : "Confirm change"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {createAccountFor && isAdmin ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close"
            onClick={() => !createAccountSaving && setCreateAccountFor(null)}
          />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
            <div className="flex items-start justify-between border-b border-border px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Create login account</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{createAccountFor.name}</p>
              </div>
              <button
                type="button"
                onClick={() => !createAccountSaving && setCreateAccountFor(null)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateAccountSubmit(e)} className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Username</label>
                <input
                  type="text"
                  required
                  autoComplete="off"
                  value={createAccountForm.username}
                  onChange={(e) =>
                    setCreateAccountForm((f) => ({ ...f, username: e.target.value }))
                  }
                  className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Password</label>
                <div className="relative">
                  <input
                    type={createAccountShowPassword ? "text" : "password"}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={createAccountForm.password}
                    onChange={(e) =>
                      setCreateAccountForm((f) => ({ ...f, password: e.target.value }))
                    }
                    className="w-full rounded-xl border border-input bg-background px-4 py-2.5 pr-10 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    placeholder="At least 6 characters"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    onClick={() => setCreateAccountShowPassword((v) => !v)}
                    aria-label={createAccountShowPassword ? "Hide password" : "Show password"}
                  >
                    {createAccountShowPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Role</label>
                <select
                  value={createAccountForm.role}
                  onChange={(e) =>
                    setCreateAccountForm((f) => ({
                      ...f,
                      role: e.target.value as AppRole,
                      adminPassword: e.target.value === "ADMIN" ? f.adminPassword : "",
                    }))
                  }
                  className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
              {createAccountForm.role === "ADMIN" ? (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    Your password <span className="font-normal text-muted-foreground">(confirm ADMIN)</span>
                  </label>
                  <div className="relative">
                    <input
                      type={createAccountShowAdminPassword ? "text" : "password"}
                      required
                      autoComplete="current-password"
                      value={createAccountForm.adminPassword}
                      onChange={(e) =>
                        setCreateAccountForm((f) => ({ ...f, adminPassword: e.target.value }))
                      }
                      className="w-full rounded-xl border border-input bg-background px-4 py-2.5 pr-10 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                      onClick={() => setCreateAccountShowAdminPassword((v) => !v)}
                      aria-label={createAccountShowAdminPassword ? "Hide password" : "Show password"}
                    >
                      {createAccountShowAdminPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  disabled={createAccountSaving}
                  onClick={() => setCreateAccountFor(null)}
                  className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createAccountSaving}
                  className="rounded-xl bg-[#4F86F7] px-4 py-2 text-sm font-medium text-white hover:bg-[#3f76e8] disabled:opacity-60"
                >
                  {createAccountSaving ? "Creating…" : "Create account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </SidebarLayout>
  );
};

export default EmployeeManagement;
